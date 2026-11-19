// Validate a market snapshot already obtained by a trusted server-side adapter.
// This module does not fetch prices and does not establish that a caller is trusted.
export function validateDemoMarketSnapshot({
  snapshot,
  expectedInstrument,
  instrumentActive,
  nowEpoch,
  maxAgeSeconds = 30,
  maxSpreadPct = 0.5
} = {}) {
  const blocked = (reason) => ({ valid: false, status: "BLOCKED", reason });

  if (!snapshot || typeof snapshot !== "object" ||
      typeof expectedInstrument !== "string" || !expectedInstrument.trim() ||
      !Number.isFinite(nowEpoch) ||
      !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 ||
      !Number.isFinite(maxSpreadPct) || maxSpreadPct <= 0 || maxSpreadPct > 5) {
    return blocked("INVALID_VALIDATION_INPUT");
  }
  if (instrumentActive !== true) return blocked("INSTRUMENT_NOT_ACTIVE");
  if (snapshot.provider !== "DERIV_SERVER_ADAPTER") return blocked("UNTRUSTED_PROVIDER");
  if (snapshot.instrument !== expectedInstrument) return blocked("INSTRUMENT_MISMATCH");
  if (snapshot.dataStatus !== "LIVE") return blocked("LIVE_DATA_REQUIRED");
  if (!Number.isFinite(snapshot.timestampEpoch)) return blocked("INVALID_MARKET_TIMESTAMP");

  const age = nowEpoch - snapshot.timestampEpoch;
  if (age < -5) return blocked("MARKET_TIMESTAMP_FROM_FUTURE");
  if (age > maxAgeSeconds) return blocked("MARKET_DATA_STALE");

  const bid = snapshot.bid;
  const ask = snapshot.ask;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return blocked("INVALID_BID_ASK");
  }
  const midpoint = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / midpoint) * 100;
  if (!Number.isFinite(spreadPct) || spreadPct > maxSpreadPct) {
    return blocked("SPREAD_TOO_WIDE");
  }

  return {
    valid: true,
    status: "VALIDATED_DEMO_MARKET_SNAPSHOT",
    paperOnly: true,
    instrument: expectedInstrument,
    provider: snapshot.provider,
    bid,
    ask,
    midpoint,
    spreadPct,
    ageSeconds: age,
    timestampEpoch: snapshot.timestampEpoch,
    note: "Validated snapshot metadata only. No trade was created and no broker order was sent."
  };
}
