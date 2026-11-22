// Resolve a platform-approved broker instrument. Provider discovery is never approval.
const SYMBOL = /^[A-Za-z0-9_]{2,30}$/;
const PROVIDERS = Object.freeze({ DERIV: "DERIV", MT5: "MT5" });

export function normalizeApprovedInstrument(value) {
  if (typeof value !== "string") return null;
  const symbol = value.trim();
  return SYMBOL.test(symbol) ? symbol.toUpperCase() : null;
}

export function resolveApprovedInstrument({
  records,
  broker,
  instrument,
  providerSymbol,
} = {}) {
  const blocked = (reason) => ({ approved: false, status: "BLOCKED", reason });
  const normalized = normalizeApprovedInstrument(instrument);
  const brokerName = typeof broker === "string" ? broker.trim().toUpperCase() : "";
  if (!Array.isArray(records) || !normalized || !PROVIDERS[brokerName] ||
      typeof providerSymbol !== "string" || !providerSymbol.trim()) {
    return blocked("INVALID_APPROVAL_LOOKUP");
  }

  const matches = records.filter((record) =>
    record && String(record.broker || "").toUpperCase() === brokerName &&
    normalizeApprovedInstrument(record.instrument) === normalized
  );
  if (matches.length !== 1) {
    return blocked(matches.length ? "AMBIGUOUS_INSTRUMENT_APPROVAL" : "INSTRUMENT_NOT_APPROVED");
  }

  const record = matches[0];
  if (record.status !== "APPROVED" || record.is_active !== true ||
      !record.approved_at || !record.approved_by) {
    return blocked("INSTRUMENT_NOT_APPROVED");
  }
  if (String(record.provider || "").toUpperCase() !== PROVIDERS[brokerName] ||
      record.provider_symbol !== providerSymbol) {
    return blocked("PROVIDER_SYMBOL_MISMATCH");
  }

  return {
    approved: true,
    status: "APPROVED_INSTRUMENT",
    broker: brokerName,
    instrument: normalized,
    provider: PROVIDERS[brokerName],
    providerSymbol: record.provider_symbol,
    approvedAt: record.approved_at,
    paperOnly: true,
    note: "Registry approval is only an instrument eligibility prerequisite; it does not authorize an order or bypass account, quote, risk, or mode checks."
  };
}
