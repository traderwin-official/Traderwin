// Deterministic tick-to-OHLC aggregation for DEMO analysis.
// This module does not connect to a feed, persist data, or execute trades.

export function ingestMarketTick({
  candles = [],
  tick,
  timeframeSeconds = 900,
  nowEpoch,
  maxAgeSeconds = 120,
  maxCandles = 300
} = {}) {
  if (!Array.isArray(candles) || !tick ||
      !Number.isInteger(timeframeSeconds) || timeframeSeconds < 60 ||
      timeframeSeconds > 86400 || !Number.isFinite(nowEpoch) ||
      !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 ||
      !Number.isInteger(maxCandles) || maxCandles < 2 || maxCandles > 2000) {
    return { status: "REJECTED", reason: "INVALID_AGGREGATION_INPUT" };
  }

  const epoch = Number(tick.epoch);
  const quote = Number(tick.quote);
  const symbol = typeof tick.symbol === "string" ? tick.symbol.trim() : "";
  if (!Number.isInteger(epoch) || !Number.isFinite(quote) || quote <= 0 || !symbol) {
    return { status: "REJECTED", reason: "INVALID_TICK" };
  }
  if (epoch > nowEpoch + 5) {
    return { status: "REJECTED", reason: "TICK_FROM_FUTURE" };
  }
  if (nowEpoch - epoch > maxAgeSeconds) {
    return { status: "REJECTED", reason: "STALE_TICK" };
  }

  const bucket = Math.floor(epoch / timeframeSeconds) * timeframeSeconds;
  const next = candles.map((c) => ({ ...c }));
  const last = next.at(-1);

  if (last) {
    if (last.symbol !== symbol) {
      return { status: "REJECTED", reason: "SYMBOL_MISMATCH" };
    }
    if (!Number.isFinite(Number(last.tick_epoch)) || epoch <= Number(last.tick_epoch)) {
      return { status: "REJECTED", reason: "DUPLICATE_OR_OUT_OF_ORDER_TICK" };
    }
    if (bucket < Number(last.bucket_epoch)) {
      return { status: "REJECTED", reason: "OLDER_CANDLE_BUCKET" };
    }
    if (bucket === Number(last.bucket_epoch)) {
      if (last.complete === true) {
        return { status: "REJECTED", reason: "CANDLE_ALREADY_CLOSED" };
      }
      last.high = Math.max(Number(last.high), quote);
      last.low = Math.min(Number(last.low), quote);
      last.close = quote;
      last.tick_epoch = epoch;
      last.tick_count = Number(last.tick_count || 0) + 1;
      return { status: "ACCEPTED", candles: next.slice(-maxCandles), closedCandle: null };
    }
    last.complete = true;
    const closedCandle = { ...last };
  }

  next.push({
    symbol,
    bucket_epoch: bucket,
    open: quote,
    high: quote,
    low: quote,
    close: quote,
    tick_epoch: epoch,
    tick_count: 1,
    complete: false
  });

  return {
    status: "ACCEPTED",
    candles: next.slice(-maxCandles),
    closedCandle: last ? { ...last, complete: true } : null
  };
}
