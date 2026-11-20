const SYMBOL_PATTERN = /^[A-Za-z0-9_]{2,30}$/;
const CONTRACT_TYPE_PATTERN = /^[A-Z0-9_]{2,40}$/;
const CATEGORY_PATTERN = /^[a-z0-9_-]{2,40}$/;

function durationSeconds(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Normalize Deriv's public contracts_for catalogue.
 * This describes available options contract types/durations only. It is NOT
 * CFD/FX lot sizing, margin, tick-value or permission to execute.
 */
export function normalizeDerivContractCatalogue(payload, expectedSymbol) {
  const expected = typeof expectedSymbol === "string" ? expectedSymbol.trim() : "";
  const source = payload?.contracts_for;
  if (!SYMBOL_PATTERN.test(expected) || payload?.msg_type !== "contracts_for" ||
      !source || typeof source !== "object" ||
      !Array.isArray(source.available)) {
    return { ok: false, reason: "INVALID_CONTRACTS_FOR_RESPONSE", contracts: [] };
  }

  const seen = new Set();
  const contracts = [];
  for (const item of source.available) {
    if (!item || typeof item !== "object" ||
        item.underlying_symbol !== expected ||
        typeof item.contract_type !== "string" ||
        !CONTRACT_TYPE_PATTERN.test(item.contract_type) ||
        typeof item.contract_category !== "string" ||
        !CATEGORY_PATTERN.test(item.contract_category) ||
        typeof item.expiry_type !== "string" ||
        typeof item.market !== "string") continue;

    const minSeconds = durationSeconds(item.min_contract_duration);
    const maxSeconds = durationSeconds(item.max_contract_duration);
    if (minSeconds === null || maxSeconds === null || maxSeconds < minSeconds) continue;

    const key = [item.underlying_symbol, item.contract_type,
      item.contract_category, item.expiry_type].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    contracts.push(Object.freeze({
      provider: "DERIV",
      providerSymbol: expected,
      contractType: item.contract_type,
      contractCategory: item.contract_category,
      expiryType: item.expiry_type,
      market: item.market,
      minDurationSeconds: minSeconds,
      maxDurationSeconds: maxSeconds,
      barriers: Number.isInteger(item.barriers) && item.barriers >= 0 ? item.barriers : null,
      sentiment: typeof item.sentiment === "string" ? item.sentiment : null,
      source: "DERIV_PUBLIC_CONTRACTS_FOR"
    }));
  }

  if (contracts.length === 0) {
    return { ok: false, reason: "NO_VALID_CONTRACT_METADATA", contracts: [] };
  }
  return { ok: true, contracts };
}
