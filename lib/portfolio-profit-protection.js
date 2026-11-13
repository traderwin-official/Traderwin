const finite = value => typeof value === "number" && Number.isFinite(value);

function normalizedIds(ids, label) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim())) {
    throw new RangeError(`${label} must be an array of non-empty position IDs.`);
  }
  return [...new Set(ids)].sort();
}

function validatePositionPeakState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("Position peak state must be an object.");
  }
  for (const [id, item] of Object.entries(value)) {
    if (!id.trim() || !item || !finite(item.peakProfitPerUnitUsd) ||
        item.peakProfitPerUnitUsd < 0 || !finite(item.units) || item.units <= 0) {
      throw new RangeError("Every saved position peak needs a non-negative per-unit peak and positive units.");
    }
  }
  return value;
}

/**
 * Tracks each position's best unrealized USD profit per unit. If TP1/TP2
 * reduces the open volume, the saved peak scales with that remaining volume.
 * This prevents a partial close from looking like a sudden portfolio giveback.
 */
export function aggregatePortfolioProfitProtection({
  positions,
  previousPeakProfitUsd = 0,
  previousIncludedPositionIds,
  previousPositionPeakState = {},
  givebackPct = 20,
  activationThresholdUsd = 20,
  manageManualTrades = false,
  manageBotTrades = true
}) {
  if (!Array.isArray(positions) || !finite(previousPeakProfitUsd) ||
      !finite(givebackPct) || !finite(activationThresholdUsd) ||
      previousPeakProfitUsd < 0 || givebackPct <= 0 || givebackPct > 50 ||
      activationThresholdUsd <= 0 || typeof manageManualTrades !== "boolean" || typeof manageBotTrades !== "boolean") {
    throw new RangeError("Invalid portfolio profit-protection inputs.");
  }
  validatePositionPeakState(previousPositionPeakState);

  const open = positions.filter(position => position && position.status === "OPEN");
  const included = [];
  const excludedManual = [];
  const excludedBot = [];
  let scope = null;

  for (const position of open) {
    const { id, userId, accountMode, broker, accountRef, source, profitUsd, units } = position;
    if (!id || !userId || !["DEMO", "REAL"].includes(accountMode) ||
        !broker || !accountRef || !["BOT", "MANUAL"].includes(source) ||
        !finite(profitUsd) || !finite(units) || units <= 0) {
      throw new RangeError("Every open position needs identity, account scope, source, USD P&L and positive remaining units.");
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
    if (source === "BOT" && !manageBotTrades) {
      excludedBot.push(id);
      continue;
    }
    included.push({ id, source, profitUsd, units });
  }

  const includedPositionIds = normalizedIds(included.map(position => position.id), "Included position IDs");
  const priorIds = previousIncludedPositionIds === undefined
    ? null
    : normalizedIds(previousIncludedPositionIds, "Previous included position IDs");
  const membershipChanged = priorIds === null ||
    priorIds.length !== includedPositionIds.length ||
    priorIds.some((id, index) => id !== includedPositionIds[index]);

  const nextPositionPeakState = {};
  let currentProfitUsd = 0;
  let peakProfitUsd = 0;
  for (const position of included) {
    currentProfitUsd += position.profitUsd;
    const previous = membershipChanged ? null : previousPositionPeakState[position.id];
    let peakProfitPerUnitUsd = position.profitUsd > 0 ? position.profitUsd / position.units : 0;
    if (previous) {
      // Volume reductions (including automatic TP partial closes) scale the old
      // per-position peak to the new remaining size. Volume increases rebase.
      const sameOrReduced = position.units <= previous.units + 1e-10;
      if (sameOrReduced) peakProfitPerUnitUsd = Math.max(peakProfitPerUnitUsd, previous.peakProfitPerUnitUsd);
    }
    const contribution = peakProfitPerUnitUsd * position.units;
    peakProfitUsd += contribution;
    nextPositionPeakState[position.id] = {
      peakProfitPerUnitUsd,
      units: position.units
    };
  }
  peakProfitUsd = Math.max(peakProfitUsd, 0);
  const trailingActive = peakProfitUsd >= activationThresholdUsd;
  const protectedFloorUsd = trailingActive ? peakProfitUsd * (1 - givebackPct / 100) : 0;
  const shouldClose = trailingActive && included.length > 0 && currentProfitUsd <= protectedFloorUsd;

  return {
    currentProfitUsd,
    peakProfitUsd,
    protectedFloorUsd,
    trailingActive,
    shouldClose,
    membershipChanged,
    includedPositionIds,
    positionPeakState: nextPositionPeakState,
    includedManualPositionIds: included.filter(position => position.source === "MANUAL").map(position => position.id).sort(),
    excludedManualPositionIds: excludedManual.sort(),
    excludedBotPositionIds: excludedBot.sort(),
    accountMode: open[0]?.accountMode ?? null,
    broker: open[0]?.broker ?? null,
    accountRef: open[0]?.accountRef ?? null,
    currency: "USD",
    givebackPct,
    activationThresholdUsd
  };
}
