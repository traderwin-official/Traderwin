import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDerivActiveSymbols } from "../lib/deriv/active-symbols.js";

test("normalizes current Deriv active-symbol response fields", () => {
  const result = normalizeDerivActiveSymbols({
    msg_type: "active_symbols",
    active_symbols: [{
      underlying_symbol: "R_100",
      underlying_symbol_name: "Volatility 100 Index",
      underlying_symbol_type: "stockindex",
      market: "synthetic_index",
      subgroup: "synthetics",
      submarket: "random_index",
      pip_size: 0.01,
      exchange_is_open: 1,
      is_trading_suspended: 0
    }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.symbols[0], {
    symbol: "R_100",
    name: "Volatility 100 Index",
    market: "synthetic_index",
    subgroup: "synthetics",
    submarket: "random_index",
    symbol_type: "stockindex",
    pip_size: 0.01,
    exchange_is_open: true,
    is_trading_suspended: false
  });
});

test("rejects wrong message type or malformed response", () => {
  assert.equal(normalizeDerivActiveSymbols({ msg_type: "tick", active_symbols: [] }).reason,
    "INVALID_ACTIVE_SYMBOLS_RESPONSE");
  assert.equal(normalizeDerivActiveSymbols(null).reason, "INVALID_ACTIVE_SYMBOLS_RESPONSE");
});

test("drops malformed symbols and deduplicates provider entries", () => {
  const result = normalizeDerivActiveSymbols({
    msg_type: "active_symbols",
    active_symbols: [
      { underlying_symbol: "EURUSD", underlying_symbol_name: "EUR/USD" },
      { underlying_symbol: "EURUSD", underlying_symbol_name: "Duplicate" },
      { underlying_symbol: "bad symbol" },
      { underlying_symbol: 123 },
      null
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.symbols.length, 1);
  assert.equal(result.symbols[0].name, "EUR/USD");
});

test("does not invent optional metadata", () => {
  const result = normalizeDerivActiveSymbols({
    msg_type: "active_symbols",
    active_symbols: [{ underlying_symbol: "XAUUSD" }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.symbols[0].pip_size, null);
  assert.equal(result.symbols[0].market, null);
  assert.equal(result.symbols[0].exchange_is_open, false);
});

test("fails when the provider returns no valid symbols", () => {
  const result = normalizeDerivActiveSymbols({
    msg_type: "active_symbols",
    active_symbols: [{ underlying_symbol: " " }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_VALID_ACTIVE_SYMBOLS");
});
