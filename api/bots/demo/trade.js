import { createClient } from "@supabase/supabase-js";

function numeric(value) { const n = Number(value); return Number.isFinite(n) ? n : NaN; }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: "Demo simulator is not configured." });
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const symbol = String(body.symbol || "").trim().toUpperCase();
    const direction = String(body.direction || "").trim().toUpperCase();
    const entry = numeric(body.entryPrice), stop = numeric(body.stopLoss), target = numeric(body.takeProfit);
    if (!/^[A-Z0-9._-]{2,24}$/.test(symbol) || !["BUY","SELL"].includes(direction) ||
        !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target) || entry <= 0 || stop <= 0 || target <= 0) {
      return res.status(400).json({ error: "Enter a valid symbol, BUY/SELL direction, entry, stop-loss and take-profit price." });
    }
    if ((direction === "BUY" && !(stop < entry && target > entry)) ||
        (direction === "SELL" && !(stop > entry && target < entry))) {
      return res.status(400).json({ error: "For BUY, stop-loss must be below entry and take-profit above. Reverse this for SELL." });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const userId = auth.user.id;
    const { data: profile, error: profileError } = await admin.from("trader_profiles")
      .select("account_mode,max_risk_per_trade_pct,max_daily_loss_pct").eq("user_id", userId).maybeSingle();
    if (profileError || !profile) return res.status(409).json({ error: "Complete your account setup first." });
    if (profile.account_mode !== "DEMO") return res.status(403).json({ error: "Paper trades are only available in DEMO mode." });
    const { data: session, error: sessionError } = await admin.from("demo_bot_sessions")
      .select("id,current_balance,max_risk_per_trade_pct,max_daily_loss_pct,status")
      .eq("user_id", userId).eq("status", "RUNNING").maybeSingle();
    if (sessionError || !session) return res.status(409).json({ error: "Start your DEMO paper-trading session first." });
    const { data: settings, error: settingsError } = await admin.from("bot_settings")
      .select("instrument,max_risk_per_trade_pct,account_mode").eq("user_id", userId).maybeSingle();
    if (settingsError || !settings || settings.account_mode !== "DEMO") return res.status(403).json({ error: "Your saved bot settings are not in DEMO mode." });
    if (symbol !== String(settings.instrument).toUpperCase()) return res.status(400).json({ error: "The trade symbol must match your saved bot instrument." });

    const riskPct = Math.min(Number(profile.max_risk_per_trade_pct), Number(session.max_risk_per_trade_pct), Number(settings.max_risk_per_trade_pct));
    if (!(riskPct > 0 && riskPct <= 2)) return res.status(403).json({ error: "Your configured risk limit is invalid." });
    const riskAmount = Number(session.current_balance) * riskPct / 100;
    const distance = Math.abs(entry - stop);
    const units = riskAmount / distance;
    if (!Number.isFinite(units) || units <= 0 || units > 1e12) return res.status(400).json({ error: "The calculated paper position size is outside safe limits." });

    const { data: todayTrades, error: dailyError } = await admin.from("demo_bot_trades")
      .select("realized_pnl").eq("user_id", userId).eq("status", "CLOSED")
      .gte("closed_at", new Date(new Date().setHours(0,0,0,0)).toISOString());
    if (dailyError) return res.status(503).json({ error: "Could not verify your daily demo loss limit." });
    const dailyLoss = (todayTrades || []).reduce((sum, trade) => sum + Math.min(0, Number(trade.realized_pnl || 0)), 0);
    const maxDailyLoss = Number(session.current_balance) * Number(session.max_daily_loss_pct) / 100;
    if (Math.abs(dailyLoss) >= maxDailyLoss) {
      await admin.from("demo_bot_sessions").update({ status: "RISK_LOCKED", stopped_at: new Date().toISOString() }).eq("id", session.id);
      await admin.from("bot_activity").insert({ user_id: userId, event_type: "RISK_BLOCK", account_mode: "DEMO", details: { reason: "DAILY_LOSS_LIMIT", daily_loss: Math.abs(dailyLoss), limit: maxDailyLoss } });
      return res.status(403).json({ error: "Daily demo loss limit reached. Session locked." });
    }
    const { data: trade, error: insertError } = await admin.from("demo_bot_trades").insert({
      session_id: session.id, user_id: userId, symbol, direction, entry_price: entry,
      stop_loss: stop, take_profit: target, virtual_units: units, risk_amount: riskAmount,
      risk_pct: riskPct, quote_source: "USER_SUPPLIED_DEMO_PRICE"
    }).select("id,symbol,direction,entry_price,stop_loss,take_profit,virtual_units,risk_amount,risk_pct,status,opened_at").single();
    if (insertError || !trade) {
      console.error("Paper trade insert failed:", insertError?.message);
      return res.status(503).json({ error: "Could not save the demo paper trade." });
    }
    await admin.from("bot_activity").insert({ user_id: userId, event_type: "DEMO_ORDER", account_mode: "DEMO", details: { trade_id: trade.id, symbol, direction, risk_amount: riskAmount, quote_source: "USER_SUPPLIED_DEMO_PRICE" } });
    return res.status(201).json({ ok: true, trade, message: "Paper trade recorded. This is not a broker order; no money or live account is involved." });
  } catch (error) {
    console.error("Demo paper trade error:", error.message);
    return res.status(500).json({ error: "Demo paper trade could not be processed." });
  }
}
