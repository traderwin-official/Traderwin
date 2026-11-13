import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getDerivPublicQuote } from "../../lib/deriv-public-quote.js";
import { getDerivCandles } from "../../lib/deriv-candles.js";
import { decideDemoAutoAction } from "../../lib/demo-auto-decision.js";

export const config = { maxDuration: 25 };

const MAX_SESSIONS_PER_TICK = 3;
const safeError = error => String(error?.message || "Worker step failed").slice(0, 240);

async function processSession(db, session) {
  const { data: settings, error: settingsError } = await db.from("bot_settings")
    .select("id,broker,instrument,account_mode,timeframe,strategy,max_risk_per_trade_pct")
    .eq("id", session.bot_setting_id)
    .eq("user_id", session.user_id)
    .maybeSingle();
  if (settingsError || !settings) return { sessionId: session.id, action: "SKIP", reason: "BOT_SETTINGS_UNAVAILABLE" };
  const { data: emergency, error: emergencyError } = await db.from("bot_emergency_controls")
    .select("kill_switch_active")
    .eq("user_id", session.user_id)
    .eq("account_mode", "DEMO")
    .eq("broker", "DERIV")
    .eq("broker_account_ref", `DEMO:${session.user_id}`)
    .maybeSingle();
  const { data: openTrade, error: openError } = await db.from("demo_bot_trades")
    .select("id,symbol,direction,entry_price,stop_loss,take_profit,tp1_price,tp2_price,tp3_price,tp1_done,tp2_done,tp3_done,virtual_units,status,trade_source")
    .eq("session_id", session.id)
    .eq("user_id", session.user_id)
    .eq("status", "OPEN")
    .maybeSingle();
  if (openError) return { sessionId: session.id, action: "ERROR", reason: "OPEN_TRADE_LOOKUP_FAILED" };
  if (emergencyError && !openTrade) return { sessionId: session.id, action: "BLOCK", reason: "EMERGENCY_STATUS_UNAVAILABLE" };
  if (openTrade && openTrade.trade_source !== "BOT") {
    return { sessionId: session.id, action: "SKIP", reason: "MANUAL_POSITION_NOT_MANAGED" };
  }
  if (session.status === "PAUSED" && !openTrade) {
    return { sessionId: session.id, action: "SKIP", reason: "SESSION_PAUSED_NO_OPEN_POSITION" };
  }
  // A kill switch blocks new entries, but an existing BOT position must still
  // receive risk-reducing stop/target management.
  if (emergency?.kill_switch_active && !openTrade) {
    return { sessionId: session.id, action: "BLOCK", reason: "KILL_SWITCH_ACTIVE" };
  }

  if (!openTrade && (String(settings.broker).toUpperCase() !== "DERIV" || settings.account_mode !== "DEMO")) {
    return { sessionId: session.id, action: "SKIP", reason: "UNSUPPORTED_BROKER_OR_MODE" };
  }

  const managedInstrument = openTrade ? openTrade.symbol : settings.instrument;
  let quote;
  try {
    quote = await getDerivPublicQuote(managedInstrument);
  } catch (error) {
    return { sessionId: session.id, action: "BLOCK", reason: "QUOTE_UNAVAILABLE", detail: safeError(error) };
  }

  let market = null;
  if (!openTrade) {
    try {
      const timeframe = settings.timeframe || "M15";
      const selectedMarket = await getDerivCandles(settings.instrument, timeframe);
      const trendMarket = (settings.strategy || "MULTI_CONFIRMATION_V1") === "TIGER_FIBONACCI_PSYCHOLOGY_V1" && timeframe !== "H1"
        ? await getDerivCandles(settings.instrument, "H1")
        : selectedMarket;
      market = { ...selectedMarket, trendCandles: trendMarket.candles };
    } catch (error) {
      return { sessionId: session.id, action: "BLOCK", reason: "CANDLE_HISTORY_UNAVAILABLE", detail: safeError(error) };
    }
  }

  let decision;
  try {
    decision = decideDemoAutoAction({
      session,
      settings,
      quote,
      market,
      openTrade,
      now: Date.now()
    });
  } catch (error) {
    return { sessionId: session.id, action: "ERROR", reason: "DECISION_ENGINE_FAILED", detail: safeError(error) };
  }

  if (decision.action === "MARK") {
    const { error } = await db.from("demo_bot_trades")
      .update({ last_mark_price: quote.quote, last_mark_at: quote.quoteAsOf })
      .eq("id", openTrade.id)
      .eq("user_id", session.user_id)
      .eq("status", "OPEN");
    return error
      ? { sessionId: session.id, action: "ERROR", reason: "MARK_SAVE_FAILED" }
      : { sessionId: session.id, action: "MARK", tradeId: openTrade.id };
  }

  if (decision.action === "TAKE_PROFIT") {
    const { data, error } = await db.rpc("manage_demo_auto_trade_exit", {
      p_user_id: session.user_id,
      p_trade_id: decision.tradeId,
      p_stage: decision.stage,
      p_exit_price: decision.exitPrice,
      p_quote_source: quote.source,
      p_quote_as_of: quote.quoteAsOf
    });
    if (error) return { sessionId: session.id, action: "ERROR", reason: "ATOMIC_TP_STAGE_FAILED", detail: safeError(error) };
    return data?.ok
      ? { sessionId: session.id, action: "TAKE_PROFIT", reason: decision.stage, tradeId: decision.tradeId, closed: data.closed, closedUnits: data.closed_units, remainingUnits: data.remaining_units, realizedPnl: data.realized_pnl_this_stage }
      : { sessionId: session.id, action: "SKIP", reason: data?.reason || "TP_STAGE_NOT_APPLIED", tradeId: decision.tradeId };
  }

  if (decision.action === "CLOSE") {
    const { data, error } = await db.rpc("close_demo_auto_trade", {
      p_user_id: session.user_id,
      p_trade_id: decision.tradeId,
      p_exit_price: decision.exitPrice,
      p_quote_source: quote.source,
      p_quote_as_of: quote.quoteAsOf,
      p_close_reason: decision.reason
    });
    if (error) return { sessionId: session.id, action: "ERROR", reason: "ATOMIC_CLOSE_FAILED", detail: safeError(error) };
    return { sessionId: session.id, action: data?.closed ? "CLOSE" : "SKIP", reason: data?.close_reason || data?.reason || decision.reason, tradeId: decision.tradeId, pnl: data?.realized_pnl };
  }

  if (decision.action === "OPEN") {
    const { data: tradeId, error } = await db.rpc("open_demo_auto_trade", {
      p_user_id: session.user_id,
      p_session_id: session.id,
      p_symbol: decision.symbol,
      p_direction: decision.direction,
      p_entry_price: decision.entry,
      p_stop_loss: decision.stop,
      p_take_profit: decision.target,
      p_virtual_units: decision.units,
      p_risk_amount: decision.riskAmount,
      p_risk_pct: decision.riskPct,
      p_quote_source: quote.source,
      p_quote_as_of: quote.quoteAsOf,
      p_candle_as_of: decision.candleAsOf
    });
    if (error) return { sessionId: session.id, action: "ERROR", reason: "ATOMIC_OPEN_FAILED", detail: safeError(error) };
    return tradeId
      ? { sessionId: session.id, action: "OPEN", tradeId, direction: decision.direction, symbol: decision.symbol, riskAmount: decision.riskAmount }
      : { sessionId: session.id, action: "SKIP", reason: "SESSION_CHANGED_OR_CANDLE_ALREADY_PROCESSED" };
  }

  if (decision.action === "WAIT" && decision.candleAsOf) {
    const { error } = await db.from("demo_bot_sessions")
      .update({ worker_last_candle_as_of: decision.candleAsOf, updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("user_id", session.user_id)
      .eq("status", "RUNNING");
    if (error) return { sessionId: session.id, action: "ERROR", reason: "CANDLE_CHECKPOINT_FAILED" };
  }
  return { sessionId: session.id, action: decision.action, reason: decision.reason };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET || CRON_SECRET.length < 32) {
    return res.status(503).json({ error: "DEMO worker is not configured." });
  }
  const authorization = req.headers.authorization || "";
  if (authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Worker authorization failed." });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const leaseToken = randomUUID();
  try {
    const { data: claimed, error: claimError } = await db.rpc("claim_traderwin_demo_worker", {
      p_lease_token: leaseToken,
      p_lease_seconds: 120
    });
    if (claimError) {
      console.error("DEMO worker lease failed:", claimError.message);
      return res.status(503).json({ error: "Could not acquire the DEMO worker lease. Apply migration 016." });
    }
    if (claimed !== true) return res.status(200).json({ ok: true, skipped: true, reason: "WORKER_ALREADY_RUNNING" });

    let results = [];
    try {
      const { data: sessions, error } = await db.from("demo_bot_sessions")
        .select("id,user_id,bot_setting_id,status,account_mode,current_balance,starting_balance,max_risk_per_trade_pct,max_daily_loss_pct,worker_last_candle_as_of")
        .in("status", ["RUNNING", "PAUSED"])
        .eq("account_mode", "DEMO")
        .order("updated_at", { ascending: true })
        .limit(MAX_SESSIONS_PER_TICK);
      if (error) throw new Error("Could not load running DEMO sessions.");
      results = await Promise.all((sessions || []).map(session =>
        processSession(db, session).catch(error => ({
          sessionId: session.id, action: "ERROR", reason: "UNHANDLED_SESSION_ERROR", detail: safeError(error)
        }))
      ));
      const tickAt = new Date().toISOString();
      const heartbeatRows = (sessions || []).map(session => {
        const result = results.find(item => item.sessionId === session.id);
        return {
          session_id: session.id,
          user_id: session.user_id,
          last_tick_at: tickAt,
          last_action: result?.action || "UNKNOWN",
          last_reason: result?.reason || null,
          last_error: result?.action === "ERROR" || result?.action === "BLOCK"
            ? (result.detail || result.reason || "Worker safety gate blocked this tick.")
            : null,
          updated_at: tickAt
        };
      });
      if (heartbeatRows.length) {
        const { error: heartbeatError } = await db.from("demo_bot_worker_heartbeats")
          .upsert(heartbeatRows, { onConflict: "session_id" });
        if (heartbeatError) console.error("DEMO worker heartbeat save failed:", heartbeatError.message);
      }
      // Move processed sessions to the back of the queue so a few older sessions
      // with open positions cannot starve other DEMO members.
      await Promise.all((sessions || []).map(async session => {
        const { error: touchError } = await db.from("demo_bot_sessions")
          .update({ updated_at: tickAt })
          .eq("id", session.id)
          .in("status", ["RUNNING", "PAUSED"]);
        if (touchError) console.error("DEMO session scheduler timestamp failed:", touchError.message);
      }));
    } finally {
      const { error: releaseError } = await db.rpc("release_traderwin_demo_worker", {
        p_lease_token: leaseToken
      });
      if (releaseError) console.error("DEMO worker lease release failed:", releaseError.message);
    }

    const counts = results.reduce((out, item) => {
      out[item.action] = (out[item.action] || 0) + 1;
      return out;
    }, {});
    return res.status(200).json({
      ok: true,
      processed: results.length,
      counts,
      results,
      mode: "DEMO_PAPER_ONLY",
      realOrdersSent: 0
    });
  } catch (error) {
    console.error("DEMO worker failed:", error.message);
    return res.status(500).json({ error: "DEMO worker encountered an error." });
  }
}
