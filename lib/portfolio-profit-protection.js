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
        !finite(item.units) || item.units <= 0) {
      throw new RangeError("Every saved portfolio-peak contribution needs a finite per-unit value and positive units.");
    }
  }
  return value;
}

/**
 * Tracks the position-level contributions at the moment the COMBINED account
 * reached its highest unrealized USD profit. Contributions are captured at the
 * same valuation snapshot; independent per-position highs are never summed.
 * When a position is partially closed or removed, its historical contribution
 * scales with remaining units or disappears, respectively.
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
  if (priorIds !== null) {
    const savedStateIds = Object.keys(previousPositionPeakState).sort();
    if (savedStateIds.length !== priorIds.length ||
        savedStateIds.some((id, index) => id !== priorIds[index])) {
      throw new RangeError("Saved portfolio peak state must match the previous included position IDs.");
    }
  }
  const membershipChanged = priorIds === null ||
    priorIds.length !== includedPositionIds.length ||
    priorIds.some((id, index) => id !== includedPositionIds[index]);

  const nextPositionPeakState = {};
  let currentProfitUsd = 0;
  let adjustedHistoricalPeakUsd = 0;
  for (const position of included) {
    currentProfitUsd += position.profitUsd;
    const previous = priorIds === null ? null : previousPositionPeakState[position.id];
    let peakProfitPerUnitUsd = 0;
    if (previous) {
      // Preserve the historical portfolio-peak contribution when size falls;
      // if size grows, preserve the old dollar contribution and baseline only
      // the added units at zero until a new combined peak is reached.
      peakProfitPerUnitUsd = position.units <= previous.units + 1e-10
        ? previous.peakProfitPerUnitUsd
        : previous.peakProfitPerUnitUsd * previous.units / position.units;
    }
    adjustedHistoricalPeakUsd += peakProfitPerUnitUsd * position.units;
    nextPositionPeakState[position.id] = {
      peakProfitPerUnitUsd,
      units: position.units
    };
  }

  let peakProfitUsd = Math.max(0, adjustedHistoricalPeakUsd);
  if (currentProfitUsd > peakProfitUsd) {
    peakProfitUsd = currentProfitUsd;
    // Capture all per-position contributions from the same combined peak tick.
    for (const position of included) {
      nextPositionPeakState[position.id] = {
        peakProfitPerUnitUsd: position.profitUsd / position.units,
        units: position.units
      };
    }
  }
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
