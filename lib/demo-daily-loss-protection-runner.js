import { createDemoPortfolioAdapters } from "./demo-portfolio-adapters.js";

const safeError = error => String(error?.message || "Daily equity protection failed safely").slice(0,180);

/**
 * DEMO-only daily equity guard. It values every open position, including
 * manual positions, but closes manual positions only with explicit close permission.
 */
export async function runDemoDailyLossProtection(db, options = {}) {
  const maxAccounts = Math.max(1, Math.min(10, Math.floor(Number(options.maxAccounts) || 3)));
  const [{data:rows,error:tradeQueueError},{data:sessions,error:sessionQueueError}] = await Promise.all([
    db.from("demo_paper_trades").select("user_id,last_mark_at").eq("status","OPEN")
      .order("last_mark_at",{ascending:true,nullsFirst:true}).limit(200),
    db.from("demo_paper_sessions").select("user_id,updated_at").in("status",["RUNNING","PAUSED","RISK_LOCKED"])
      .order("updated_at",{ascending:true}).limit(200)
  ]);
  if (tradeQueueError || sessionQueueError) throw new Error("Could not build the daily-loss valuation queue.");
  const userIds = options.userIds || [...new Set([
    ...(rows || []).map(row=>row.user_id),
    ...(sessions || []).map(row=>row.user_id)
  ].filter(Boolean))].slice(0,maxAccounts);
  const results = await Promise.all(userIds.map(async userId => {
    const scope={userId,accountMode:"DEMO",broker:"DERIV",accountRef:"DEMO:"+userId};
    try {
      const adapters=createDemoPortfolioAdapters(db,options);
      let snapshot=await adapters.loadSnapshot(scope);
      let permissions={manageManualTrades:false,closeManualTrades:false,closeManagedPositions:false};
      try { permissions=await adapters.loadPermissions(scope); } catch { /* manual close stays disabled; BOT protection remains active */ }
      const floatingPnlUsd=snapshot.positions.reduce((sum,p)=>sum+p.profitUsd,0);
      const {data:guard,error:guardError}=await db.rpc("evaluate_demo_daily_loss_guard",{
        p_user_id:userId,p_floating_pnl_usd:floatingPnlUsd
      });
      if(guardError||!guard?.ok) throw new Error("Could not evaluate the account-wide daily loss limit.");
      const markResults=await Promise.all(snapshot.positions.map(async position=>{
        const {error}=await db.rpc("mark_demo_paper_trade",{
          p_user_id:userId,p_trade_id:position.id,p_price:position.currentPrice,p_quote_as_of:position.quoteAsOf
        });
        return {tradeId:position.id,ok:!error};
      }));
      if(markResults.some(result=>!result.ok)) throw new Error("Could not advance the fresh DEMO valuation queue.");
      if(!guard.triggered) return {userId,status:"MONITORED",...guard,openPositions:snapshot.positions.length};
      // Re-read after the SQL lock is committed so an entry that raced the first
      // valuation cannot remain open after the account has been locked.
      snapshot=await adapters.loadSnapshot(scope);
      const eligible=snapshot.positions.filter(p=>
        p.source==="BOT" ||
        (permissions.manageManualTrades && permissions.closeManualTrades && permissions.closeManagedPositions)
      );
      const closes=await Promise.all(eligible.map(async position=>{
        try {
          const result=await adapters.closeDailyLossPosition(position,{
            idempotencyKey:"daily-loss:"+guard.trading_day+":"+position.id
          });
          return {tradeId:position.id,source:position.source,...result};
        } catch(error) {
          return {tradeId:position.id,source:position.source,closed:false,reason:safeError(error)};
        }
      }));
      return {userId,status:"LIMIT_REACHED",...guard,openPositions:snapshot.positions.length,
        closeAttempts:closes.length,closed:closes.filter(x=>x.closed).length,
        manualPositionsLeftOpen:snapshot.positions.filter(p=>p.source==="MANUAL").length-closes.filter(x=>x.source==="MANUAL"&&x.closed).length,
        closes};
    } catch(error) {
      return {userId,status:"ERROR",reason:safeError(error)};
    }
  }));
  return {processed:results.length,results,healthy:results.every(r=>r.status!=="ERROR")};
}
