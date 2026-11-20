import test from "node:test";
import assert from "node:assert/strict";
import { buildDemoPortfolioPositions, createDemoPortfolioAdapters } from "../lib/demo-portfolio-adapters.js";

const scope = { userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "DEMO:u1" };
const quote = { instrument: "EURUSD", providerSymbol: "frxEURUSD", quote: 1.105, quoteAsOf: "2026-11-20T03:00:00.000Z", source: "DERIV" };
const conversion = { rate: 1, source: "USD_QUOTED_INSTRUMENT", asOf: quote.quoteAsOf };

test("DEMO portfolio valuation aggregates BOT and MANUAL positions in USD", () => {
  const trades = [
    { id: "bot-1", user_id: "u1", instrument: "EURUSD", side: "BUY", entry_price: 1.1, remaining_quantity: 100, status: "OPEN", trade_origin: "BOT" },
    { id: "manual-1", user_id: "u1", instrument: "EURUSD", side: "SELL", entry_price: 1.11, remaining_quantity: 50, status: "OPEN", trade_origin: "MANUAL" }
  ];
  const positions = buildDemoPortfolioPositions(trades, { EURUSD: { quote, conversion } }, scope);
  assert.equal(positions.length, 2);
  assert.equal(positions[0].profitUsd, 0.5);
  assert.equal(positions[1].profitUsd, 0.25);
  assert.deepEqual(positions.map(p => p.source), ["BOT", "MANUAL"]);
  assert.ok(positions.every(p => p.accountRef === "DEMO:u1" && p.accountMode === "DEMO"));
});

test("DEMO valuation fails closed when a quote or conversion is missing", () => {
  const trade = { id: "p1", user_id: "u1", instrument: "EURUSD", side: "BUY", entry_price: 1.1, remaining_quantity: 1, status: "OPEN", trade_origin: "BOT" };
  assert.throws(() => buildDemoPortfolioPositions([trade], {}, scope), /verified quote/);
  assert.throws(() => buildDemoPortfolioPositions([trade], { EURUSD: { quote, conversion: { rate: 0 } } }, scope), /verified quote/);
});

test("DEMO portfolio close uses only the atomic virtual-ledger RPC and a fresh quote", async () => {
  const calls = [];
  const db = {
    from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }; },
    async rpc(name, args) { calls.push({ name, args }); return { data: { ok: true }, error: null }; }
  };
  const adapters = createDemoPortfolioAdapters(db, {
    getQuote: async () => quote,
    getQuoteToUsd: async () => conversion
  });
  const result = await adapters.closePosition({
    id: "p1", userId: "u1", accountMode: "DEMO", broker: "DERIV",
    accountRef: "DEMO:u1", instrument: "EURUSD"
  }, { reason: "PORTFOLIO_PROFIT_GIVEBACK" });
  assert.deepEqual(result, { closed: true, status: "CLOSED" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "close_demo_paper_trade");
  assert.equal(calls[0].args.p_reason, "PORTFOLIO_PROFIT_GIVEBACK");
});
