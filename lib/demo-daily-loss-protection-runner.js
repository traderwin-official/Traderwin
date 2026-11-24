import { createDemoPortfolioAdapters } from "./demo-portfolio-adapters.js";

const safeError = error => String(error?.message || "Daily equity protection failed safely").slice(0,180);

/**
 * DEMO-only daily equity guard. It values every open position, including
 * manual positions, but closes manual positions only with explicit close permission.
 */
export async function runDemoDailyLossProtection(db, options = {}) {
  const maxAccounts = Math.max(1, Math.min(10, Math.floor(Number(options.maxAccounts) || 3)));
  const { data: rows, error } = await db.from("demo_paper_trades")
    .select("user_id,last_mark_at").eq("status","OPEN")
    .order("last_mark_at",{ascending:true,nullsFirst:true}).limit(200);
  if (error) throw new Error("Could not build the daily-loss valuation queue.");
  const userIds = options.userIds || [...new Set((rows || []).map(row=>row.user_id).filter(Boolean))].slice(0,maxAccounts);
  const results = await Promise.all(userIds.map(async userId => {
    const scope={userId,accountMode:"DEMO",broker:"DERIV",accountRef:"DEMO:"+userId};
    try {
      const adapters=createDemoPortfolioAdapters(db,options);
      const [snapshot,permissions]=await Promise.all([adapters.loadSnapshot(scope),adapters.loadPermissions(scope)]);
      const floatingPnlUsd=snapshot.positions.reduce((sum,p)=>sum+p.profitUsd,0);
      const {data:guard,error:guardError}=await db.rpc("evaluate_demo_daily_loss_guard",{
        p_user_id:userId,p_floating_pnl_usd:floatingPnlUsd
      });
      if(guardError||!guard?.ok) throw new Error("Could not evaluate the account-wide daily loss limit.");
      if(!guard.triggered) return {userId,status:"MONITORED",...guard,openPositions:snapshot.positions.length};
      const eligible=snapshot.positions.filter(p=>
        p.source==="BOT"
          ? permissions.manageBotTrades && permissions.closeManagedPositions
          : permissions.manageManualTrades && permissions.closeManualTrades && permissions.closeManagedPositions
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
