import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDailyEquityLoss } from "../lib/demo-daily-loss-protection.js";

test("allows trading at 81 when opening equity is 100",()=>{
  const r=evaluateDailyEquityLoss({openingBalanceUsd:100,realizedPnlUsd:-19,floatingPnlUsd:0});
  assert.equal(r.triggered,false);
  assert.equal(r.currentEquityUsd,81);
  assert.equal(r.triggerEquityUsd,80);
});
test("triggers exactly at 20 percent below opening equity",()=>{
  const r=evaluateDailyEquityLoss({openingBalanceUsd:100,realizedPnlUsd:-20,floatingPnlUsd:0});
  assert.equal(r.triggered,true);
  assert.equal(r.reason,"DAILY_LOSS_LIMIT_REACHED");
});
test("counts floating loss before it is realized",()=>{
  const r=evaluateDailyEquityLoss({openingBalanceUsd:100,realizedPnlUsd:5,floatingPnlUsd:-25});
  assert.equal(r.currentEquityUsd,80);
  assert.equal(r.triggered,true);
});
test("uses the day's opening balance, not an intraday profit peak",()=>{
  const r=evaluateDailyEquityLoss({openingBalanceUsd:100,realizedPnlUsd:20,floatingPnlUsd:-40});
  assert.equal(r.currentEquityUsd,80);
  assert.equal(r.triggered,true);
});
test("rejects configurable percentages other than fixed 20 percent",()=>{
  assert.equal(evaluateDailyEquityLoss({openingBalanceUsd:100,lossLimitPct:2}).reason,"INVALID_DAILY_EQUITY_INPUT");
});
