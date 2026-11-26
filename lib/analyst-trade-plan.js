const finite = Number.isFinite;

export function buildAnalystTradePlan({ direction, quote, atr, instrument, timeframe, now = Date.now(), maxQuoteAgeMs = 30000 } = {}) {
  const side = String(direction || "").toUpperCase();
  if (!["BUY", "SELL"].includes(side)) return { status: "NO_DIRECTIONAL_SETUP", entry: null, stopLoss: null, takeProfit1: null, takeProfit2: null };
  const stamp = Date.parse(quote?.quoteAsOf || "");
  const bid = Number(quote?.bid), ask = Number(quote?.ask), volatility = Number(atr);
  if (quote?.source !== "DERIV" || !quote.providerSymbol ||
      !finite(stamp) || !finite(now) || now - stamp < 0 || now - stamp > maxQuoteAgeMs ||
      !finite(bid) || !finite(ask) || bid <= 0 || ask < bid ||
      !finite(volatility) || volatility <= 0 ||
      !/^[A-Z0-9_]{2,24}$/.test(String(instrument || ""))) {
    return { status: "UNAVAILABLE", entry: null, stopLoss: null, takeProfit1: null, takeProfit2: null,
      reason: "A fresh verified Deriv bid and ask plus valid ATR are required. Last-price quotes are not substituted." };
  }
  const entry = side === "BUY" ? ask : bid;
  const riskDistance = volatility * 1.5;
  const stopLoss = side === "BUY" ? entry - riskDistance : entry + riskDistance;
  const takeProfit1 = side === "BUY" ? entry + riskDistance * 1.5 : entry - riskDistance * 1.5;
  const takeProfit2 = side === "BUY" ? entry + riskDistance * 2 : entry - riskDistance * 2;
  if (![entry, stopLoss, takeProfit1, takeProfit2].every(finite) ||
      (side === "BUY" && !(stopLoss < entry && takeProfit1 > entry && takeProfit2 > takeProfit1)) ||
      (side === "SELL" && !(stopLoss > entry && takeProfit1 < entry && takeProfit2 < takeProfit1))) {
    return { status: "UNAVAILABLE", entry: null, stopLoss: null, takeProfit1: null, takeProfit2: null,
      reason: "The proposed levels failed directional validation." };
  }
  return {
    status: "INDICATIVE_ONLY",
    instrument: String(instrument).toUpperCase(),
    timeframe: String(timeframe || "").toUpperCase(),
    direction: side,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskDistance,
    riskReward1: 1.5,
    riskReward2: 2,
    quoteSource: "DERIV",
    quoteAsOf: quote.quoteAsOf,
    entrySide: side === "BUY" ? "ASK" : "BID",
    disclaimer: "Indicative research levels from the current bid/ask and ATR. Not an executable broker quote or an instruction to trade."
  };
}
