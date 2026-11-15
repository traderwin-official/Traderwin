import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO entry obtains its entry price from the server-side Deriv quote adapter", async () => {
  const source = await readFile(new URL("../api/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(source, /getDerivPublicQuote\(symbol\)/);
  assert.match(source, /const entry = quote\.quote/);
  assert.match(source, /p_quote_source: quote\.source/);
  assert.match(source, /rpc\("open_demo_manual_trade"/);
  assert.match(source, /getDerivQuoteToUsd/);
  assert.match(source, /quoteToUsd: conversion\.rate/);
  assert.match(source, /p_quote_to_usd: conversion\.rate/);
  assert.doesNotMatch(source, /from\("demo_bot_trades"\)\s*\.insert/);
  assert.doesNotMatch(source, /num\(b\.entryPrice\)/);
  assert.doesNotMatch(source, /USER_SUPPLIED_DEMO_PRICE|UNVERIFIED/);
});

test("DEMO mark and close use fresh server-side quotes rather than browser prices", async () => {
  const mark = await readFile(new URL("../api/bots/demo/mark.js", import.meta.url), "utf8");
  const close = await readFile(new URL("../api/bots/demo/close.js", import.meta.url), "utf8");
  assert.match(mark, /getDerivPublicQuote\(trade\.symbol\)/);
  assert.match(mark, /const currentPrice = quote\.quote/);
  assert.match(mark, /last_mark_at: quote\.quoteAsOf/);
  assert.match(mark, /getDerivQuoteToUsd/);
  assert.match(mark, /quoteToUsd: conversion\.rate/);
  assert.match(mark, /normalise\(quote\.instrument\).*normalise\(trade\.symbol\)/s);
  assert.doesNotMatch(mark, /Number\(body\.currentPrice\)/);
  assert.match(close, /getDerivPublicQuote\(trade\.symbol\)/);
  assert.match(close, /p_exit_price: quote\.quote/);
  assert.match(close, /getDerivQuoteToUsd/);
  assert.match(close, /p_quote_to_usd: conversion\.rate/);
  assert.doesNotMatch(close, /Number\(b\.exitPrice\)/);
});

test("DEMO ledger requires an approved source label and quote timestamp", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120005_demo_paper_trading.sql", import.meta.url), "utf8");
  assert.match(sql, /quote_source text not null check\(quote_source in\('DERIV','MT5','VERIFIED_DATA_PROVIDER'\)\)/);
  assert.match(sql, /quote_as_of timestamptz not null/);
  assert.doesNotMatch(sql, /USER_SUPPLIED_DEMO_PRICE/);
});
