// Normalize Deriv's public active_symbols response without activating instruments.
const SYMBOL_PATTERN = /^[A-Za-z0-9_]{2,30}$/;

export function normalizeDerivActiveSymbols(payload) {
  if (!payload || payload.msg_type !== "active_symbols" ||
      !Array.isArray(payload.active_symbols)) {
    return { ok: false, reason: "INVALID_ACTIVE_SYMBOLS_RESPONSE", symbols: [] };
  }

  const seen = new Set();
  const symbols = [];
  for (const item of payload.active_symbols) {
    if (!item || typeof item.underlying_symbol !== "string" ||
        !SYMBOL_PATTERN.test(item.underlying_symbol) ||
        seen.has(item.underlying_symbol)) continue;

    seen.add(item.underlying_symbol);
    symbols.push({
      symbol: item.underlying_symbol,
      name: typeof item.underlying_symbol_name === "string"
        ? item.underlying_symbol_name.slice(0, 120) : item.underlying_symbol,
      market: typeof item.market === "string" ? item.market : null,
      subgroup: typeof item.subgroup === "string" ? item.subgroup : null,
      submarket: typeof item.submarket === "string" ? item.submarket : null,
      symbol_type: typeof item.underlying_symbol_type === "string"
        ? item.underlying_symbol_type : null,
      pip_size: Number.isFinite(item.pip_size) && item.pip_size > 0
        ? item.pip_size : null,
      exchange_is_open: item.exchange_is_open === 1,
      is_trading_suspended: item.is_trading_suspended === 1
    });
  }

  if (symbols.length === 0) {
    return { ok: false, reason: "NO_VALID_ACTIVE_SYMBOLS", symbols: [] };
  }
  return { ok: true, symbols };
}
