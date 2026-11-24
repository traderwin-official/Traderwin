import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("manual DEMO pending batch uses a server verified Deriv quote and never accepts an immediate browser fill",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/pending-batches.js",import.meta.url),"utf8");
 assert.match(s,/getDerivPublicQuote\(symbol\)/);
 assert.match(s,/freshQuote\(quote,symbol\)/);
 assert.match(s,/getDerivQuoteToUsd/);
 assert.match(s,/create_demo_manual_entry_batch/);
 assert.match(s,/num\(body\.entryPrice\)/);
 assert.match(s,/positions activate only after a later verified quote crosses/);
 assert.doesNotMatch(s,/buy\(|sell\(|placeOrder|sendBrokerOrder/i);
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
