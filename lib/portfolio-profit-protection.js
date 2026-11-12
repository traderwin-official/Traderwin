const finite = value => typeof value === "number" && Number.isFinite(value);

export function aggregatePortfolioProfitProtection({
  positions,
  previousPeakProfitUsd = 0,
  givebackPct = 20,
  activationThresholdUsd = 20,
  manageManualTrades = false
}) {
  if (!Array.isArray(positions) || !finite(previousPeakProfitUsd) ||
      !finite(givebackPct) || !finite(activationThresholdUsd) ||
      previousPeakProfitUsd < 0 || givebackPct <= 0 || givebackPct > 50 ||
      activationThresholdUsd <= 0) {
    throw new RangeError("Invalid portfolio profit-protection inputs.");
  }

  const open = positions.filter(position => position && position.status === "OPEN");
  const included = [];
  const excludedManual = [];
  let scope = null;

  for (const position of open) {
    const { id, userId, accountMode, broker, accountRef, source, profitUsd } = position;
    if (!id || !userId || !["DEMO", "REAL"].includes(accountMode) ||
        !broker || !accountRef || !["BOT", "MANUAL"].includes(source) ||
        !finite(profitUsd)) {
      throw new RangeError("Every open position needs a valid identity, account scope, source and USD-normalized P&L.");
    }
    const currentScope = [userId, accountMode, broker, accountRef].join("|");
    if (scope !== null && currentScope !== scope) {
      throw new RangeError("Aggregate positions from exactly one user, broker account and account mode at a time.");
    }
    scope = currentScope;
    if (source === "MANUAL" && !manageManualTrades) {
      excludedManual.push(id);
      continue;
    }
    included.push({ id, source, profitUsd });
  }

  const currentProfitUsd = included.reduce((sum, position) => sum + position.profitUsd, 0);
  const peakProfitUsd = Math.max(previousPeakProfitUsd, currentProfitUsd, 0);
  const trailingActive = peakProfitUsd >= activationThresholdUsd;
  const protectedFloorUsd = trailingActive ? peakProfitUsd * (1 - givebackPct / 100) : 0;
  const shouldClose = trailingActive && included.length > 0 && currentProfitUsd <= protectedFloorUsd;

  return {
    currentProfitUsd,
    peakProfitUsd,
    protectedFloorUsd,
    trailingActive,
    shouldClose,
    includedPositionIds: included.map(position => position.id),
    includedManualPositionIds: included.filter(position => position.source === "MANUAL").map(position => position.id),
    excludedManualPositionIds: excludedManual,
    accountMode: open[0]?.accountMode ?? null,
    broker: open[0]?.broker ?? null,
    accountRef: open[0]?.accountRef ?? null,
    currency: "USD",
    givebackPct,
    activationThresholdUsd
  };
}
