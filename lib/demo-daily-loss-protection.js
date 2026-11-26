const finite = value => typeof value === "number" && Number.isFinite(value);

export function evaluateDailyEquityLoss({
  openingBalanceUsd,
  realizedPnlUsd = 0,
  floatingPnlUsd = 0,
  lossLimitPct = 20
} = {}) {
  if (!finite(openingBalanceUsd) || openingBalanceUsd <= 0 ||
      !finite(realizedPnlUsd) || !finite(floatingPnlUsd) ||
      lossLimitPct !== 20) {
    return { allowed: false, triggered: false, reason: "INVALID_DAILY_EQUITY_INPUT" };
  }
  const lossLimitUsd = openingBalanceUsd * 0.20;
  const currentEquityUsd = Math.max(0, openingBalanceUsd + realizedPnlUsd + floatingPnlUsd);
  const triggerEquityUsd = Math.max(0, openingBalanceUsd - lossLimitUsd);
  const triggered = currentEquityUsd <= triggerEquityUsd;
  return {
    allowed: !triggered,
    triggered,
    openingBalanceUsd,
    realizedPnlUsd,
    floatingPnlUsd,
    currentEquityUsd,
    lossLimitPct: 20,
    lossLimitUsd,
    triggerEquityUsd,
    remainingLossBudgetUsd: Math.max(0, currentEquityUsd - triggerEquityUsd),
    reason: triggered ? "DAILY_LOSS_LIMIT_REACHED" : "DAILY_LOSS_LIMIT_NOT_REACHED"
  };
}
