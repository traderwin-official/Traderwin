const validText = value => typeof value === "string" && value.trim().length > 0;
const finite = value => typeof value === "number" && Number.isFinite(value);

export const SUPPORTED_BROKERS = Object.freeze(["DERIV", "MT5"]);
export const ACCOUNT_MODES = Object.freeze(["DEMO", "REAL"]);

/**
 * Shared validation boundary for broker portfolio adapters. This deliberately
 * accepts only verified USD P&L; adapters must not guess contract sizes or FX
 * conversion rates. Broker-specific identity is retained for close requests.
 */
export function validateBrokerPortfolioSnapshot(snapshot, scope, now = Date.now()) {
  if (!scope || !validText(scope.userId) || !ACCOUNT_MODES.includes(scope.accountMode) ||
      !SUPPORTED_BROKERS.includes(scope.broker) || !validText(scope.accountRef)) {
    return { ok: false, reason: "INVALID_ACCOUNT_SCOPE" };
  }
  if (!snapshot || !Array.isArray(snapshot.positions) || !validText(snapshot.source) ||
      !validText(snapshot.asOf) || !Number.isFinite(Date.parse(snapshot.asOf)) ||
      !Number.isSafeInteger(snapshot.maxAgeMs) || snapshot.maxAgeMs <= 0) {
    return { ok: false, reason: "INVALID_MARKET_SNAPSHOT" };
  }
  const ageMs = now - Date.parse(snapshot.asOf);
  if (ageMs < 0 || ageMs > snapshot.maxAgeMs) return { ok: false, reason: "STALE_MARKET_DATA", ageMs };
  for (const position of snapshot.positions) {
    if (!position || position.userId !== scope.userId ||
        position.accountMode !== scope.accountMode || position.broker !== scope.broker ||
        position.accountRef !== scope.accountRef ||
        !validText(position.id) || !["BOT", "MANUAL"].includes(position.source) ||
        position.status !== "OPEN" || !finite(position.profitUsd) ||
        position.profitCurrency !== "USD") {
      return { ok: false, reason: "UNVERIFIED_POSITION_OR_USD_VALUATION" };
    }
  }
  return { ok: true, ageMs, positionCount: snapshot.positions.length };
}

export function createBrokerAdapterRegistry(adapters = {}) {
  const registry = new Map();
  for (const broker of SUPPORTED_BROKERS) {
    const adapter = adapters[broker];
    if (adapter !== undefined) {
      if (adapter.broker !== broker || typeof adapter.loadSnapshot !== "function" ||
          typeof adapter.closePosition !== "function") {
        throw new TypeError(`Invalid ${broker} portfolio adapter.`);
      }
      registry.set(broker, adapter);
    }
  }
  return Object.freeze({
    supports: broker => registry.has(broker),
    get: broker => registry.get(broker) || null,
    list: () => [...registry.keys()]
  });
}
