import test from "node:test";
import assert from "node:assert/strict";
import { calculateDerivDailyRealizedPnl } from "../lib/deriv/daily-realized-pnl.js";

const dayStartEpoch = 1_800_000_000;
const dayEndEpoch = dayStartEpoch + 86400;
const row = (overrides = {}) => ({
  transaction_id: 101, contract_id: 501, purchase_time: dayStartEpoch - 60,
  sell_time: dayStartEpoch + 30, buy_price: 10, payout: 18,
  sell_price: 18, ...overrides
});
const page = (transactions, offset = 0, limit = 500) => ({
  offset, limit, payload: { msg_type: "profit_table", profit_table: {
    count: transactions.length, transactions
  }}
});

test("calculates realized P&L by provider sell_time, not purchase_time", () => {
  const result = calculateDerivDailyRealizedPnl({
    pages: [page([row(), row({transaction_id:102,contract_id:502,sell_time:dayEndEpoch-1,buy_price:5,sell_price:2,payout:2})])],
    expectedAccountId:"VRTC12345", accountMode:"DEMO", accountCurrency: "USD", dayStartEpoch, dayEndEpoch
  });
  assert.equal(result.ok, true);
  assert.equal(result.realizedPnl, 5);
  assert.equal(result.closedContracts, 2);
  assert.equal(result.currency, "USD");
  assert.equal(result.accountId, "VRTC12345");
  assert.equal(result.accountMode, "DEMO");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.historyComplete, true);
});

test("excludes contracts sold outside the requested half-open day interval", () => {
  const result = calculateDerivDailyRealizedPnl({
    pages: [page([
      row({sell_time:dayStartEpoch-1}),
      row({transaction_id:102,contract_id:502,sell_time:dayEndEpoch})
    ])],
    expectedAccountId:"VRTC12345", accountMode:"DEMO", accountCurrency: "USD", dayStartEpoch, dayEndEpoch
  });
  assert.equal(result.ok, true);
  assert.equal(result.realizedPnl, 0);
  assert.equal(result.closedContracts, 0);
});

test("requires complete contiguous pagination including a short terminal page", () => {
  const fullRows = Array.from({length:2}, (_,i) => row({transaction_id:200+i,contract_id:600+i}));
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page(fullRows,0,2)], expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).reason, "REALIZED_PNL_HISTORY_NOT_COMPLETE");
  const complete = calculateDerivDailyRealizedPnl({
    pages:[page(fullRows,0,2),page([],2,2)],
    expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  });
  assert.equal(complete.ok,true);
  assert.equal(complete.transactionsScanned,2);
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page(fullRows,0,2),page([],3,2)],
    expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).reason,"REALIZED_PNL_PAGE_INVALID_OR_INCOMPLETE");
});

test("blocks malformed rows, duplicate identifiers, missing sell times and bad currency", () => {
  const invalid = [
    row({sell_time:null}),
    row({buy_price:"10"}),
    row({sell_price:-1}),
    row({payout:NaN}),
    row({contract_id:null}),
    row({transaction_id:0})
  ];
  for (const item of invalid) {
    assert.equal(calculateDerivDailyRealizedPnl({
      pages:[page([item])],expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
    }).ok,false);
  }
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page([row(),row({transaction_id:102})])],
    expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).reason,"REALIZED_PNL_TRANSACTION_INVALID");
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page([])],expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"US",dayStartEpoch,dayEndEpoch
  }).reason,"REALIZED_PNL_INPUT_INVALID");
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page([])],expectedAccountId:"VRTC12345",accountMode:"REAL",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).reason,"REALIZED_PNL_INPUT_INVALID");
});

test("rejects inconsistent counts, wrong message types, gaps and pages after end", () => {
  const badCount = page([row()]);
  badCount.payload.profit_table.count = 2;
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[badCount],expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).ok,false);
  const wrongType = page([]);
  wrongType.payload.msg_type = "statement";
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[wrongType],expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).ok,false);
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page([row()],0,2),page([],3,2)],
    expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).ok,false);
  assert.equal(calculateDerivDailyRealizedPnl({
    pages:[page([],0,2),page([],2,2)],
    expectedAccountId:"VRTC12345",accountMode:"DEMO",accountCurrency:"USD",dayStartEpoch,dayEndEpoch
  }).reason,"REALIZED_PNL_PAGES_AFTER_END");
});
