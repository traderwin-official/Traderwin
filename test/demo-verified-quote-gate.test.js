import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO entry obtains price from server Deriv quote and opens through v2 RPC",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/trade.js",import.meta.url),"utf8");
 assert.match(s,/getDerivPublicQuote\(symbol\)/);assert.match(s,/const entry=quote\.quote/);
 assert.match(s,/open_demo_manual_partial_trade/);assert.match(s,/p_quote_source:quote\.source/);
 assert.match(s,/getDerivQuoteToUsd/);assert.match(s,/p_quote_to_usd:conversion\.rate/);
 assert.doesNotMatch(s,/from\("demo_bot_trades"\)\s*\.insert/);assert.doesNotMatch(s,/num\(b\.entryPrice\)/);
});
test("DEMO mark and close use fresh verified quotes and v2 records",async()=>{
 const mark=await readFile(new URL("../handlers/bots/demo/mark.js",import.meta.url),"utf8");
 const close=await readFile(new URL("../handlers/bots/demo/close.js",import.meta.url),"utf8");
 assert.match(mark,/getDerivPublicQuote\(t\.instrument\)/);assert.match(mark,/mark_demo_paper_trade/);
 assert.match(mark,/getDerivQuoteToUsd/);assert.match(close,/getDerivPublicQuote\(t\.instrument\)/);
 assert.match(close,/close_demo_paper_trade/);assert.match(close,/p_exit_price:q\.quote/);
 assert.doesNotMatch(close,/Number\(b\.exitPrice\)/);
});
test("v2 paper ledger enforces Deriv quote source and freshness",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611200001_demo_paper_ledger_v2.sql",import.meta.url),"utf8");
 assert.match(sql,/quote_source text not null check \(quote_source = 'DERIV'\)/);
 assert.match(sql,/p_quote_as_of<now\(\)-interval '30 seconds'/);
});
