import { monitorPortfolio } from "./portfolio-monitor.js";
import { createDemoPortfolioAdapters } from "./demo-portfolio-adapters.js";

const safeReason = error => String(error?.message || "Portfolio monitor failed safely").slice(0, 180);

/**
 * Run the combined 20% DEMO giveback monitor for a bounded set of paper
 * accounts. The caller must hold the shared DEMO worker lease.
 */
export async function runDemoPortfolioProtection(db, options = {}) {
  const maxAccounts = Math.max(1, Math.min(10, Math.floor(Number(options.maxAccounts) || 3)));
  const { data: openRows, error } = await db.from("demo_paper_trades")
    .select("user_id,last_mark_at")
    .eq("status", "OPEN")
    .order("last_mark_at", { ascending: true, nullsFirst: true })
    .limit(200);
  if (error) throw new Error("Could not build the DEMO portfolio monitor queue.");

  const userIds = [...new Set((openRows || []).map(row => row.user_id).filter(Boolean))].slice(0, maxAccounts);
  const results = await Promise.all(userIds.map(async userId => {
    const scope = { userId, accountMode: "DEMO", broker: "DERIV", accountRef: "DEMO:" + userId };
    try {
      const adapters = createDemoPortfolioAdapters(db, options);
      const result = await monitorPortfolio(scope, adapters, { now: options.now ?? Date.now() });
      // Advance this account's queue cursor only after a successful valuation
      // or a completed protection decision. Failed/blocked accounts are retried.
      if (["MONITORED", "CLOSE_REQUESTED", "PARTIAL_CLOSE", "CLOSE_BLOCKED"].includes(result.status)) {
        const { error: markError } = await db.from("demo_paper_trades")
          .update({ last_mark_at: new Date(options.now ?? Date.now()).toISOString() })
          .eq("user_id", userId).eq("status", "OPEN");
        if (markError) return { userId, status: "ERROR", reason: "PORTFOLIO_QUEUE_UPDATE_FAILED" };
      }
      return { userId, ...result };
    } catch (error) {
      const { error: queueError } = await db.from("demo_paper_trades")
        .update({ last_mark_at: new Date(options.now ?? Date.now()).toISOString() })
        .eq("user_id", userId).eq("status", "OPEN");
      return { userId, status: "ERROR", reason: queueError ? "PORTFOLIO_QUEUE_UPDATE_FAILED" : safeReason(error) };
    }
  }));
  return { processed: results.length, results };
}
