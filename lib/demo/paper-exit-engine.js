// Young Tiger FX deterministic DEMO paper-trade exit evaluator.
// Pure calculation only: no database writes, broker calls, or order execution.

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function evaluatePaperExit({ trade, candle } = {}) {
  if (!trade || !candle) {
    return { status: "REJECTED", reason: "MISSING_TRADE_OR_CANDLE" };
  }

  const side = trade.side;
  const entry = Number(trade.entry_price);
  const quantity = Number(trade.quantity);
  const stop = Number(trade.stop_loss);
  const target = Number(trade.take_profit);
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (!["BUY", "SELL"].includes(side) ||
      ![entry, quantity, stop, target, open, high, low, close].every(Number.isFinite) ||
      ![entry, quantity, stop, target, open, high, low, close].every((v) => v > 0) ||
      low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    return { status: "REJECTED", reason: "INVALID_TRADE_OR_OHLC_DATA" };
  }

  const isBuy = side === "BUY";
  if ((isBuy && !(stop < entry && target > entry)) ||
      (!isBuy && !(target < entry && stop > entry))) {
    return { status: "REJECTED", reason: "INVALID_PROTECTIVE_LEVELS" };
  }

  let exitPrice = null;
  let exitReason = null;

  // Gap handling: use the candle open when it is worse/better than the level.
  if (isBuy && open <= stop) {
    exitPrice = open;
    exitReason = "STOP_LOSS_GAP";
  } else if (!isBuy && open >= stop) {
    exitPrice = open;
    exitReason = "STOP_LOSS_GAP";
  } else if (isBuy && open >= target) {
    exitPrice = open;
    exitReason = "TAKE_PROFIT_GAP";
  } else if (!isBuy && open <= target) {
    exitPrice = open;
    exitReason = "TAKE_PROFIT_GAP";
  } else {
    const stopHit = isBuy ? low <= stop : high >= stop;
    const targetHit = isBuy ? high >= target : low <= target;

    // If OHLC cannot reveal intrabar order, assume the adverse stop happened first.
    if (stopHit) {
      exitPrice = stop;
      exitReason = targetHit ? "STOP_LOSS_BOTH_LEVELS_TOUCHED" : "STOP_LOSS";
    } else if (targetHit) {
      exitPrice = target;
      exitReason = "TAKE_PROFIT";
    }
  }

  if (exitPrice === null) {
    return { status: "HOLD", reason: "NO_EXIT_LEVEL_TOUCHED", markPrice: close };
  }

  const direction = isBuy ? 1 : -1;
  const pricePnl = (exitPrice - entry) * quantity * direction;
  return {
    status: "CLOSED",
    exitPrice,
    exitReason,
    pricePnl: Number(pricePnl.toFixed(8)),
    note: "DEMO simulation only. pricePnl is price movement multiplied by quantity; it excludes contract multipliers, fees, spread, swaps and slippage."
  };
}
