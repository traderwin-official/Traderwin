const APPROVED_AUTO_STRATEGIES = new Set(["AUTO_SELECT_V1","MULTI_CONFIRMATION_V1","TIGER_FIBONACCI_PSYCHOLOGY_V1"]);

// MANUAL remains the database session type. Automation is an explicit, separate
// DEMO-only opt-in stored in config_snapshot and never enables broker orders.
export function resolveDemoAutoStrategy(session) {
  if (!session || !["RUNNING","PAUSED","RISK_LOCKED"].includes(session.status)) return null;
  if (session.strategy !== "MANUAL") return APPROVED_AUTO_STRATEGIES.has(session.strategy) ? session.strategy : null;
  const config = session.config_snapshot && typeof session.config_snapshot === "object" ? session.config_snapshot : {};
  if (config.account_mode !== "DEMO" || config.execution !== "WEBSITE_PAPER_ONLY" || config.auto_trading_enabled !== true) return null;
  const strategy = String(config.auto_strategy || "").trim().toUpperCase();
  return APPROVED_AUTO_STRATEGIES.has(strategy) ? strategy : null;
}
