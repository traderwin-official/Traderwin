import {calculateScalpingRisk,buildScalpingTargets,evaluateScalpingExit} from "./scalping-execution.js";

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export async function openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch,quoteToUsd,now=Date.now()}) {
  if (!db || typeof db.rpc !== "function") throw new TypeError("A trusted Supabase service client is required.");
  const config = session?.config_snapshot && typeof session.config_snapshot === "object" ? session.config_snapshot : {};
  if (!session || session.broker !== "DERIV" || session.status !== "RUNNING" ||
      config.account_mode !== "DEMO" ||
      !["WEBSITE_PAPER_ONLY","WEBSITE_DEMO_AUTO_PAPER_ONLY"].includes(config.execution)) {
    return {ok:false,reason:"ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED"};
  }
  if (!preference || preference.enabled !== true || preference.account_mode !== "DEMO" ||
      preference.execution !== "WEBSITE_PAPER_ONLY" ||
      Number(preference.max_risk_per_trade_pct) <= 0 ||
      Number(preference.max_risk_per_trade_pct) > 0.25 ||
      Number(preference.max_daily_loss_pct) <= 0 ||
      Number(preference.max_daily_loss_pct) > 1 ||
      Number(preference.max_open_positions) !== 1) {
    return {ok:false,reason:"SCALPING_DEMO_OPT_IN_REQUIRED"};
  }
  if (!signal || !["BUY","SELL"].includes(signal.direction) ||
      !finitePositive(signal.entry) || !finitePositive(signal.stopLoss) ||
      !finitePositive(signal.takeProfit) || !Number.isFinite(candleEpoch) || candleEpoch <= 0) {
    return {ok:false,reason:"VALID_SCALPING_SIGNAL_REQUIRED"};
  }
  const quoteAsOf = Date.parse(tick?.quoteAsOf);
  const receivedAt = Date.parse(tick?.receivedAt);
  if (!tick || tick.source !== "DERIV" || tick.instrument !== signal.instrument ||
      !finitePositive(tick.bid) || !finitePositive(tick.ask) || Number(tick.ask) < Number(tick.bid) ||
      !Number.isFinite(quoteAsOf) || !Number.isFinite(receivedAt) ||
      quoteAsOf > now + 1000 || receivedAt > now + 1000 ||
      now - quoteAsOf > 10000 || now - receivedAt > 3000) {
    return {ok:false,reason:"FRESH_VERIFIED_DERIV_BID_ASK_REQUIRED"};
  }
  if (!finitePositive(quoteToUsd)) return {ok:false,reason:"USD_CONVERSION_UNAVAILABLE"};
  const entry = Number(signal.direction === "BUY" ? tick.ask : tick.bid);
  const stopLoss = Number(signal.stopLoss);
  const takeProfit = Number(signal.takeProfit);
  const size = calculateScalpingRisk({
    balance:Number(session.current_balance),
    entry,
    stopLoss,
    quoteToUsd:Number(quoteToUsd),
    riskPct:Math.min(0.25,Number(preference.max_risk_per_trade_pct))
  });
  const targets = buildScalpingTargets({direction:signal.direction,entry,stopLoss,takeProfit});
  const {data,error} = await db.rpc("open_demo_scalping_paper_trade",{
    p_user_id:session.user_id,
    p_session_id:session.id,
    p_instrument:session.instrument,
    p_side:signal.direction,
    p_entry:entry,
    p_stop:stopLoss,
    p_target:targets.tp3,
    p_tp1:targets.tp1,
    p_tp2:targets.tp2,
    p_tp3:targets.tp3,
    p_quantity:size.quantity,
    p_risk_amount:size.riskAmount,
    p_risk_pct:size.riskPct,
    p_quote_to_usd:Number(quoteToUsd),
    p_quote_as_of:new Date(quoteAsOf).toISOString(),
    p_candle_as_of:new Date(candleEpoch*1000).toISOString()
  });
  if (error) throw error;
  return data || {ok:false,reason:"EMPTY_SCALPING_EXECUTION_RESPONSE"};
}

export async function manageScalpingPaperPosition({db,trade,tick,now=Date.now()}) {
  if (!trade || trade.status !== "OPEN" || trade.trade_origin !== "BOT" ||
      trade.metadata?.strategy !== "TIGER_SCHEME_QUANTUM_SCALPING") {
    return {action:"SKIP",reason:"NOT_A_SCALPING_BOT_POSITION"};
  }
  const decision = evaluateScalpingExit({
    trade,
    bid:Number(tick?.bid),
    ask:Number(tick?.ask),
    quoteAsOf:tick?.quoteAsOf,
    receivedAt:tick?.receivedAt,
    now
  });
  if (decision.action !== "EXIT") return decision;
  const {data,error} = await db.rpc("manage_demo_paper_exit",{
    p_user_id:trade.user_id,
    p_trade_id:trade.id,
    p_stage:decision.stage,
    p_exit_price:decision.price,
    p_quote_to_usd:Number(trade.quote_to_usd),
    p_quote_source:"DERIV",
    p_quote_as_of:new Date(Date.parse(tick.quoteAsOf)).toISOString()
  });
  if (error) throw error;
  return {action:"EXIT",stage:decision.stage,result:data};
}
