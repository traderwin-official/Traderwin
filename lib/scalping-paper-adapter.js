import {calculateScalpingRisk,buildScalpingTargets,evaluateScalpingExit} from "./scalping-execution.js";

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

async function openBatchWithRecovery(db,args) {
  const rpcName="open_demo_scalping_paper_trade_batch_with_lease";
  const recoveryName="get_demo_scalping_entry_batch_with_lease";
  const recover=async()=>{
    const {data,error}=await db.rpc(recoveryName,{
      p_lease_token:args.p_lease_token,
      p_user_id:args.p_user_id,
      p_session_id:args.p_session_id,
      p_entry_key:args.p_entry_key
    });
    if(error)throw error;
    if(data?.ok===true)return data;
    if(data?.reason==="SCALPING_BATCH_NOT_FOUND")return null;
    throw new Error(data?.reason||"SCALPING_BATCH_RECOVERY_NOT_CONFIRMED");
  };

  const first=await db.rpc(rpcName,args);
  if(!first.error)return first.data||{ok:false,reason:"EMPTY_SCALPING_EXECUTION_RESPONSE"};

  // A timeout can happen after PostgreSQL committed. Never create a new key:
  // inspect the durable ledger first, then retry the exact same arguments only
  // when the ledger proves that this key was not committed.
  const recovered=await recover();
  if(recovered)return recovered;

  const retry=await db.rpc(rpcName,args);
  if(!retry.error)return retry.data||{ok:false,reason:"EMPTY_SCALPING_EXECUTION_RESPONSE"};

  const recoveredAfterRetry=await recover();
  if(recoveredAfterRetry)return recoveredAfterRetry;
  throw first.error;
}

export async function openScalpingPaperPosition({db,session,preference,signal,tick,candleEpoch,quoteToUsd,leaseToken,now=Date.now()}) {
  if (!db || typeof db.rpc !== "function") throw new TypeError("A trusted Supabase service client is required.");
  if (typeof leaseToken !== "string" || !leaseToken) return {ok:false,reason:"SCALPING_WORKER_LEASE_NOT_OWNED"};
  const config = session?.config_snapshot && typeof session.config_snapshot === "object" ? session.config_snapshot : {};
  if (!session || session.broker !== "DERIV" || session.status !== "RUNNING" ||
      config.account_mode !== "DEMO" ||
      !["WEBSITE_PAPER_ONLY","WEBSITE_DEMO_AUTO_PAPER_ONLY"].includes(config.execution)) {
    return {ok:false,reason:"ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED"};
  }
  if (!preference || preference.enabled !== true || preference.paper_execution_enabled !== true || preference.account_mode !== "DEMO" ||
      preference.execution !== "WEBSITE_PAPER_ONLY" ||
      Number(preference.max_risk_per_trade_pct) <= 0 ||
      Number(preference.max_risk_per_trade_pct) > 0.25 ||
      Number(preference.max_daily_loss_pct) <= 0 ||
      Number(preference.max_daily_loss_pct) > 1 ||
      !Number.isInteger(Number(preference.max_open_positions)) ||
      Number(preference.max_open_positions) < 1 || Number(preference.max_open_positions) > 15 ||
      !Number.isInteger(Number(session.max_open_positions)) ||
      Number(session.max_open_positions) < 1 || Number(session.max_open_positions) > 15) {
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
  if (typeof db.from !== "function" || !finitePositive(session.starting_balance)) {
    return {ok:false,reason:"PORTFOLIO_RISK_CONTEXT_UNAVAILABLE"};
  }
  const {data:openRows,error:openRowsError}=await db.from("demo_paper_trades")
    .select("risk_amount_usd,quantity,remaining_quantity")
    .eq("user_id",session.user_id).eq("status","OPEN");
  if(openRowsError)throw openRowsError;
  const openTrades=openRows||[];
  const maxOpenPositions=Math.min(15,Number(preference.max_open_positions),Number(session.max_open_positions));
  if(openTrades.length>=maxOpenPositions)return {ok:false,reason:"SCALPING_MAX_OPEN_POSITIONS"};
  const openRisk=openTrades.reduce((sum,row)=>{
    const quantity=Number(row.quantity),remaining=Number(row.remaining_quantity),risk=Number(row.risk_amount_usd);
    return sum+(quantity>0&&remaining>0&&finitePositive(risk)?risk*remaining/quantity:0);
  },0);
  const sessionRiskLimit=Number(session.current_balance)*Number(session.max_total_open_risk_pct)/100;
  const portfolioRiskLimit=Math.min(Number(session.starting_balance)*0.01,sessionRiskLimit);
  const remainingRisk=Math.max(0,portfolioRiskLimit-openRisk);
  const remainingSlots=maxOpenPositions-openTrades.length;
  const allocatedRisk=remainingRisk/remainingSlots;
  if(!finitePositive(allocatedRisk))return {ok:false,reason:"SCALPING_TOTAL_OPEN_RISK_LIMIT"};
  const riskPct=Math.min(0.25,Number(preference.max_risk_per_trade_pct),
    Number(session.risk_per_trade_pct),allocatedRisk/Number(session.current_balance)*100);
  const size = calculateScalpingRisk({
    balance:Number(session.current_balance),
    entry,
    stopLoss,
    quoteToUsd:Number(quoteToUsd),
    riskPct
  });
  const targets = buildScalpingTargets({direction:signal.direction,entry,stopLoss,takeProfit});
  const entries = Array.from({length:remainingSlots},()=>({
    instrument:session.instrument,
    side:signal.direction,
    entry,
    stop:stopLoss,
    target:targets.tp3,
    tp1:targets.tp1,
    tp2:targets.tp2,
    tp3:targets.tp3,
    quantity:size.quantity,
    risk_amount:size.riskAmount,
    risk_pct:size.riskPct,
    quote_to_usd:Number(quoteToUsd),
    quote_as_of:new Date(quoteAsOf).toISOString(),
    candle_as_of:new Date(candleEpoch*1000).toISOString()
  }));
  const rpcArgs={
    p_lease_token:leaseToken,
    p_user_id:session.user_id,
    p_session_id:session.id,
    p_entries:entries,
    p_entry_as_of:new Date(now).toISOString(),
    p_entry_key:`quantum-batch:${session.id}:${signal.instrument}:${signal.direction}:${Math.floor(quoteAsOf/1000)}`
  };
  return await openBatchWithRecovery(db,rpcArgs);
}

export async function manageScalpingPaperPosition({db,trade,tick,leaseToken,now=Date.now()}) {
  if (!trade || trade.status !== "OPEN" || trade.trade_origin !== "BOT" ||
      trade.metadata?.strategy !== "TIGER_SCHEME_QUANTUM_SCALPING") {
    return {action:"SKIP",reason:"NOT_A_SCALPING_BOT_POSITION"};
  }
  if (typeof leaseToken !== "string" || !leaseToken) return {action:"SKIP",reason:"SCALPING_WORKER_LEASE_NOT_OWNED"};
  const decision = evaluateScalpingExit({
    trade,
    bid:Number(tick?.bid),
    ask:Number(tick?.ask),
    quoteAsOf:tick?.quoteAsOf,
    receivedAt:tick?.receivedAt,
    now
  });
  if (decision.action !== "EXIT") return decision;
  const {data,error} = await db.rpc("manage_demo_scalping_paper_exit_with_lease",{p_lease_token:leaseToken,
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
