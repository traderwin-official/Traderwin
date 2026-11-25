const finite = Number.isFinite;

function positive(value, name) {
  if (!finite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number.`);
}

export function calculateScalpingRisk({ balance, entry, stopLoss, quoteToUsd = 1, riskPct = 0.25 }) {
  positive(balance, "balance");
  positive(entry, "entry");
  positive(stopLoss, "stopLoss");
  positive(quoteToUsd, "quoteToUsd");
  if (!finite(riskPct) || riskPct <= 0 || riskPct > 0.25) {
    throw new RangeError("Scalping risk must be greater than 0 and no more than 0.25%.");
  }
  const distance = Math.abs(entry - stopLoss);
  if (!finite(distance) || distance <= 0) throw new RangeError("Stop-loss distance must be positive.");
  const riskBudget = balance * riskPct / 100;
  const quantity = Math.floor((riskBudget / (distance * quoteToUsd)) * 1e12) / 1e12;
  if (!finite(quantity) || quantity <= 0) throw new RangeError("Calculated position quantity is too small.");
  const riskAmount = Math.round(distance * quantity * quoteToUsd * 100) / 100;
  const actualRiskPct = riskAmount / balance * 100;
  if (riskAmount <= 0 || actualRiskPct > riskPct + 1e-9) {
    throw new RangeError("Calculated position exceeds the requested risk budget.");
  }
  return { quantity, riskAmount, riskPct: actualRiskPct, riskBudget };
}

export function buildScalpingTargets({ direction, entry, stopLoss, takeProfit }) {
  if (!["BUY", "SELL"].includes(direction)) throw new RangeError("Direction must be BUY or SELL.");
  positive(entry, "entry");
  positive(stopLoss, "stopLoss");
  positive(takeProfit, "takeProfit");
  const risk = Math.abs(entry - stopLoss);
  if (!finite(risk) || risk <= 0) throw new RangeError("Stop-loss distance must be positive.");
  const reward = direction === "BUY" ? takeProfit - entry : entry - takeProfit;
  const rewardRisk = reward / risk;
  if (!finite(rewardRisk) || rewardRisk < 1.5 || rewardRisk > 3) {
    throw new RangeError("Final scalping target must be between 1.5R and 3R.");
  }
  const sign = direction === "BUY" ? 1 : -1;
  const tp1 = entry + sign * risk * 0.75;
  const tp2 = entry + sign * risk * 1.1;
  if (direction === "BUY" ? !(entry < tp1 && tp1 < tp2 && tp2 < takeProfit)
    : !(entry > tp1 && tp1 > tp2 && tp2 > takeProfit)) {
    throw new RangeError("Scalping targets are not correctly ordered.");
  }
  return { tp1, tp2, tp3: takeProfit, rewardRisk };
}

export function evaluateScalpingExit({ trade, bid, ask, quoteAsOf, receivedAt, now = Date.now() }) {
  if (!trade || !["BUY", "SELL"].includes(trade.side)) return { action: "WAIT", reason: "INVALID_TRADE" };
  if (![bid, ask].every(v => finite(v) && v > 0) || ask < bid) {
    return { action: "WAIT", reason: "VERIFIED_BID_ASK_REQUIRED" };
  }
  const asOf = typeof quoteAsOf === "number" ? quoteAsOf : Date.parse(quoteAsOf);
  const received = typeof receivedAt === "number" ? receivedAt : Date.parse(receivedAt);
  if (!finite(asOf) || !finite(received) || asOf > now + 1000 || received > now + 1000 ||
      now - asOf > 10000 || now - received > 3000) {
    return { action: "WAIT", reason: "EXIT_QUOTE_STALE" };
  }
  const price = trade.side === "BUY" ? bid : ask;
  if (trade.side === "BUY" ? price <= trade.stop_loss : price >= trade.stop_loss) {
    return { action: "EXIT", stage: "STOP_LOSS", price };
  }
  const reached = (level) => finite(level) && level > 0 &&
    (trade.side === "BUY" ? price >= level : price <= level);
  if (!trade.tp1_done && reached(trade.tp1_price)) return { action: "EXIT", stage: "TP1", price };
  if (trade.tp1_done && !trade.tp2_done && reached(trade.tp2_price)) return { action: "EXIT", stage: "TP2", price };
  if (trade.tp2_done && !trade.tp3_done && reached(trade.tp3_price)) return { action: "EXIT", stage: "TP3", price };
  return { action: "HOLD", price };
}
