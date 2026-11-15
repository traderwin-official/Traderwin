import { createClient } from "@supabase/supabase-js";
import { validatePaperSetup, calculatePaperPosition } from "../../../lib/demo-risk.js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Demo simulator is not configured." });
  }
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const direction = String(body.direction || "").trim().toUpperCase();
    const stop = num(body.stopLoss);
    const target = num(body.takeProfit);
    if (!/^[A-Z0-9._-]{2,24}$/.test(symbol)) {
      return res.status(400).json({ error: "Enter a valid instrument symbol." });
    }
    if (!Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) {
      return res.status(400).json({ error: "Enter valid stop-loss and take-profit levels." });
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }
    const userId = auth.user.id;

    const { data: profile, error: profileError } = await db.from("trader_profiles")
      .select("account_mode,max_risk_per_trade_pct")
      .eq("user_id", userId).maybeSingle();
    if (profileError || !profile) {
      return res.status(409).json({ error: "Complete your account setup first." });
    }
    if (profile.account_mode !== "DEMO") {
      return res.status(403).json({ error: "Paper trades are DEMO-only." });
    }

    const { data: session, error: sessionError } = await db.from("demo_bot_sessions")
      .select("id,current_balance,starting_balance,max_risk_per_trade_pct,max_daily_loss_pct,status")
      .eq("user_id", userId).eq("status", "RUNNING").maybeSingle();
    if (sessionError || !session) {
      return res.status(409).json({ error: "Start your DEMO paper session first." });
    }

    const { data: settings, error: settingsError } = await db.from("bot_settings")
      .select("broker,instrument,account_mode,max_risk_per_trade_pct")
      .eq("user_id", userId).maybeSingle();
    if (settingsError || !settings || settings.account_mode !== "DEMO") {
      return res.status(403).json({ error: "Saved bot settings are not in DEMO mode." });
    }
    if (String(settings.broker || "").toUpperCase() !== "DERIV") {
      return res.status(503).json({ error: "The verified MT5 quote adapter is not connected yet. No paper trade was recorded." });
    }
    if (normalise(symbol) !== normalise(settings.instrument)) {
      return res.status(400).json({ error: "Symbol must match your saved bot instrument." });
    }

    const { data: emergencyControl, error: emergencyError } = await db.from("bot_emergency_controls")
      .select("kill_switch_active")
      .eq("user_id", userId).eq("account_mode", "DEMO")
      .eq("broker", "DERIV").eq("broker_account_ref", `DEMO:${userId}`)
      .maybeSingle();
    if (emergencyError) {
      return res.status(503).json({ error: "Emergency control status is unavailable. No paper trade was recorded." });
    }
    if (emergencyControl?.kill_switch_active) {
      return res.status(403).json({ error: "Emergency stop is active. New paper trades are blocked." });
    }

    let quote;
    try {
      quote = await getDerivPublicQuote(symbol);
    } catch (error) {
      return res.status(503).json({ error: error.message || "Could not obtain a fresh Deriv quote." });
    }
    if (quote.source !== "DERIV" || normalise(quote.instrument) !== normalise(symbol) ||
        typeof quote.providerSymbol !== "string" || !quote.providerSymbol.trim()) {
      return res.status(503).json({ error: "The verified quote does not match the selected instrument. No paper trade was recorded." });
    }

    const entry = quote.quote;
    const setupError = validatePaperSetup({ direction, entry, stop, target });
    if (setupError) return res.status(400).json({ error: setupError });

    const { data: modeProfile, error: modeError } = await db.from("bot_mode_profiles")
      .select("profit_giveback_pct,max_risk_per_trade_pct")
      .eq("user_id", userId).eq("account_mode", "DEMO").maybeSingle();
    if (modeError) return res.status(503).json({ error: "Could not verify DEMO risk preferences." });

    const givebackPct = Math.min(50, Math.max(1, Number(modeProfile?.profit_giveback_pct || 20)));
    const riskPct = Math.min(
      Number(profile.max_risk_per_trade_pct),
      Number(session.max_risk_per_trade_pct),
      Number(settings.max_risk_per_trade_pct),
      Number(modeProfile?.max_risk_per_trade_pct || profile.max_risk_per_trade_pct)
    );
    let sizing;
    try {
      sizing = calculatePaperPosition({
        balance: Number(session.current_balance), riskPct, entry, stop
      });
    } catch {
      return res.status(400).json({ error: "Could not calculate safe paper position size." });
    }
    if (!Number.isFinite(sizing.units) || sizing.units <= 0 || sizing.units > 1e12) {
      return res.status(400).json({ error: "Paper position size is outside safe limits." });
    }

    const { data: result, error: openError } = await db.rpc("open_demo_manual_trade", {
      p_user_id: userId,
      p_session_id: session.id,
      p_symbol: symbol,
      p_direction: direction,
      p_entry_price: entry,
      p_stop_loss: stop,
      p_take_profit: target,
      p_virtual_units: sizing.units,
      p_risk_amount: sizing.riskAmount,
      p_risk_pct: riskPct,
      p_profit_giveback_pct: givebackPct,
      p_quote_source: quote.source,
      p_quote_as_of: quote.quoteAsOf
    });
    if (openError) {
      console.error("Atomic manual DEMO entry failed:", openError.message);
      return res.status(503).json({ error: "Paper trade could not be saved safely. Please retry after the DEMO database update is installed." });
    }
    if (!result?.ok) {
      const messages = {
        SESSION_NOT_RUNNING: "Your DEMO session is no longer running.",
        INSTRUMENT_MISMATCH: "The trade instrument no longer matches your saved settings.",
        KILL_SWITCH_ACTIVE: "Emergency stop is active. New paper trades are blocked.",
        DAILY_LOSS_LIMIT: "Your daily DEMO loss limit has been reached. The session is locked.",
        OPEN_POSITION_EXISTS: "Close your existing open paper position before opening another."
      };
      const status = result?.reason === "KILL_SWITCH_ACTIVE" || result?.reason === "DAILY_LOSS_LIMIT" ? 403 : 409;
      return res.status(status).json({ error: messages[result?.reason] || "Paper trade was blocked by a server-side risk check." });
    }

    const trade = {
      id: result.trade_id,
      symbol: result.symbol,
      direction: result.direction,
      entry_price: Number(result.entry_price),
      stop_loss: Number(result.stop_loss),
      take_profit: Number(result.take_profit),
      virtual_units: Number(result.virtual_units),
      risk_amount: Number(result.risk_amount),
      risk_pct: Number(result.risk_pct),
      profit_giveback_pct: Number(result.profit_giveback_pct),
      status: result.status,
      opened_at: result.opened_at
    };
    return res.status(201).json({
      ok: true,
      trade,
      quote: { source: quote.source, asOf: quote.quoteAsOf, instrument: quote.providerSymbol },
      message: "Paper trade recorded. Entry and risk checks were committed atomically; no broker order or real money is involved."
    });
  } catch (error) {
    console.error("Paper trade:", error.message);
    return res.status(500).json({ error: "Paper trade could not be processed." });
  }
}
