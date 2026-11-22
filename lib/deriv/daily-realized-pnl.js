/**
 * Strict daily realized P&L normalizer for authenticated Deriv Options profit_table pages.
 *
 * Callers must fetch every page from offset 0 until a short page is returned.
 * We intentionally do not use profit_table date filters: Deriv's public request
 * schema does not specify whether those filters apply to purchase_time or sell_time.
 */
export function calculateDerivDailyRealizedPnl({
  pages, expectedAccountId, accountMode, accountCurrency, dayStartEpoch, dayEndEpoch
}) {
  const currency = typeof accountCurrency === "string" ? accountCurrency.toUpperCase() : "";
  if (!Array.isArray(pages) || pages.length === 0 ||
      typeof expectedAccountId !== "string" || !/^[A-Z]{2,4}[0-9]{1,10}$/.test(expectedAccountId) ||
      accountMode !== "DEMO" ||
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isSafeInteger(dayStartEpoch) || dayStartEpoch < 0 ||
      !Number.isSafeInteger(dayEndEpoch) || dayEndEpoch <= dayStartEpoch) {
    return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_INPUT_INVALID" };
  }

  let expectedOffset = 0;
  let pageSize = null;
  let reachedEnd = false;
  const transactionIds = new Set();
  const contractIds = new Set();
  let realized = 0;
  let closedContracts = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const limit = page?.limit;
    const offset = page?.offset;
    const payload = page?.payload;
    const table = payload?.profit_table;
    const rows = table?.transactions;

    if (reachedEnd || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
        !Number.isSafeInteger(offset) || offset !== expectedOffset ||
        (pageSize !== null && limit !== pageSize) ||
        payload?.msg_type !== "profit_table" ||
        !table || !Number.isSafeInteger(table.count) ||
        !Array.isArray(rows) || table.count !== rows.length || rows.length > limit) {
      return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_PAGE_INVALID_OR_INCOMPLETE" };
    }
    pageSize = limit;

    for (const row of rows) {
      if (!row || !Number.isSafeInteger(row.transaction_id) || row.transaction_id <= 0 ||
          !Number.isSafeInteger(row.contract_id) || row.contract_id <= 0 ||
          !Number.isSafeInteger(row.purchase_time) || row.purchase_time < 0 ||
          !Number.isSafeInteger(row.sell_time) || row.sell_time <= 0 ||
          typeof row.buy_price !== "number" || !Number.isFinite(row.buy_price) || row.buy_price < 0 ||
          typeof row.sell_price !== "number" || !Number.isFinite(row.sell_price) || row.sell_price < 0 ||
          typeof row.payout !== "number" || !Number.isFinite(row.payout) || row.payout < 0 ||
          transactionIds.has(row.transaction_id) || contractIds.has(row.contract_id)) {
        return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_TRANSACTION_INVALID" };
      }
      transactionIds.add(row.transaction_id);
      contractIds.add(row.contract_id);

      if (row.sell_time >= dayStartEpoch && row.sell_time < dayEndEpoch) {
        realized += row.sell_price - row.buy_price;
        closedContracts += 1;
        if (!Number.isFinite(realized)) {
          return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_OVERFLOW" };
        }
      }
    }

    expectedOffset += limit;
    if (rows.length < limit) {
      reachedEnd = true;
      if (pageIndex !== pages.length - 1) {
        return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_PAGES_AFTER_END" };
      }
    }
  }

  if (!reachedEnd) {
    return { ok: false, status: "BLOCKED", reason: "REALIZED_PNL_HISTORY_NOT_COMPLETE" };
  }

  return Object.freeze({
    ok: true,
    status: "COMPLETE_READ_ONLY_REALIZED_PNL",
    accountId: expectedAccountId,
    accountMode: "DEMO",
    currency,
    dayStartEpoch,
    dayEndEpoch,
    realizedPnl: realized,
    closedContracts,
    transactionsScanned: transactionIds.size,
    source: "DERIV_AUTHENTICATED_PROFIT_TABLE_SELL_TIME",
    calculation: "SUM_OF_SELL_PRICE_MINUS_BUY_PRICE",
    historyComplete: true,
    executionAuthorized: false
  });
}
