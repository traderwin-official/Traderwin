const ACCOUNT_ID_PATTERN = /^[A-Z]{2,4}[0-9]{1,10}$/;

function finiteMoney(value) {
  const amount = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function isoTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

/** Normalize a genuine Deriv balance response from the account-scoped WS session. */
export function normalizeDerivBalanceResponse(payload, expectedAccountId, receivedAt = new Date().toISOString()) {
  const balance = payload?.balance;
  if (payload?.msg_type !== "balance") return { ok: false, reason: "BALANCE_RESPONSE_TYPE_INVALID" };
  const loginid = typeof balance?.loginid === "string" ? balance.loginid : "";
  const amount = finiteMoney(balance?.balance);
  const currency = typeof balance?.currency === "string" ? balance.currency.trim().toUpperCase() : "";
  if (!ACCOUNT_ID_PATTERN.test(expectedAccountId || "") || loginid !== expectedAccountId ||
      amount === null || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, reason: "BALANCE_RESPONSE_INVALID_OR_ACCOUNT_MISMATCH" };
  }
  const timestamp = isoTimestamp(receivedAt);
  if (!timestamp) return { ok: false, reason: "BALANCE_TIMESTAMP_INVALID" };
  return Object.freeze({
    ok: true,
    accountId: expectedAccountId,
    balance: amount,
    currency,
    asOf: timestamp,
    receivedAt: isoTimestamp(receivedAt),
    source: "DERIV_AUTHENTICATED_BALANCE"
  });
}

/** Normalize only open contracts from the account-scoped Deriv portfolio response. */
export function normalizeDerivPortfolioResponse(payload, expectedAccountId, receivedAt = new Date().toISOString()) {
  const portfolio = payload?.portfolio;
  if (payload?.msg_type !== "portfolio") return { ok: false, reason: "PORTFOLIO_RESPONSE_TYPE_INVALID" };
  if (!ACCOUNT_ID_PATTERN.test(expectedAccountId || "") || !portfolio ||
      !Array.isArray(portfolio.contracts)) {
    return { ok: false, reason: "PORTFOLIO_RESPONSE_INVALID" };
  }
  const contracts = [];
  const seen = new Set();
  for (const item of portfolio.contracts) {
    if (!item || typeof item !== "object") return { ok: false, reason: "PORTFOLIO_CONTRACT_INVALID" };
    const contractId = item.contract_id;
    const symbol = item.underlying_symbol;
    const currency = typeof item.currency === "string" ? item.currency.toUpperCase() : "";
    const buyPrice = finiteMoney(item.buy_price);
    if (!(typeof contractId === "number" && Number.isSafeInteger(contractId) && contractId > 0) ||
        typeof symbol !== "string" || !symbol.trim() ||
        !/^[A-Z]{3}$/.test(currency) || buyPrice === null ||
        seen.has(String(contractId))) {
      return { ok: false, reason: "PORTFOLIO_CONTRACT_INVALID" };
    }
    seen.add(String(contractId));
    contracts.push(Object.freeze({
      contractId,
      symbol,
      contractType: typeof item.contract_type === "string" ? item.contract_type : null,
      currency,
      buyPrice,
      payout: finiteMoney(item.payout),
      dateStart: isoTimestamp(item.date_start),
      purchaseTime: isoTimestamp(item.purchase_time),
      expiryTime: isoTimestamp(item.expiry_time),
      source: "DERIV_AUTHENTICATED_PORTFOLIO"
    }));
  }
  return Object.freeze({
    ok: true,
    accountId: expectedAccountId,
    contracts,
    openContractCount: contracts.length,
    asOf: isoTimestamp(receivedAt),
    source: "DERIV_AUTHENTICATED_PORTFOLIO"
  });
}


function signedMoney(value) {
  const amount = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(amount) ? amount : null;
}

/** Normalize one fresh provider valuation for a contract in the selected account. */
export function normalizeDerivOpenContractValuation(payload, expectedContractId, {
  now = Date.now(), maxAgeSeconds = 30
} = {}) {
  const contract = payload?.proposal_open_contract;
  if (payload?.msg_type !== "proposal_open_contract" || !contract ||
      !Number.isSafeInteger(expectedContractId) || expectedContractId <= 0 ||
      contract.contract_id !== expectedContractId || contract.status !== "open") {
    return { ok: false, reason: "OPEN_CONTRACT_ID_OR_STATUS_MISMATCH" };
  }
  const currency = typeof contract.currency === "string" ? contract.currency.toUpperCase() : "";
  const buyPrice = finiteMoney(contract.buy_price);
  const bidPrice = finiteMoney(contract.bid_price);
  const profit = signedMoney(contract.profit);
  const quoteEpoch = contract.current_spot_time;
  if (!/^[A-Z]{3}$/.test(currency) || buyPrice === null || bidPrice === null ||
      profit === null || !Number.isSafeInteger(quoteEpoch) || quoteEpoch <= 0) {
    return { ok: false, reason: "OPEN_CONTRACT_VALUATION_INVALID" };
  }
  const ageMs = now - quoteEpoch * 1000;
  if (ageMs < -2000 || ageMs > maxAgeSeconds * 1000) {
    return { ok: false, reason: "OPEN_CONTRACT_VALUATION_STALE" };
  }
  return Object.freeze({
    ok: true,
    contractId: expectedContractId,
    currency,
    buyPrice,
    bidPrice,
    profit,
    currentSpotTime: new Date(quoteEpoch * 1000).toISOString(),
    status: "open",
    source: "DERIV_AUTHENTICATED_OPEN_CONTRACT"
  });
}

/** Combine balance, portfolio and per-contract valuations for the selected account. */
export function buildDerivAccountSnapshot({ balance, portfolio, valuations, expectedAccountId, now = Date.now(), maxAgeMs = 15000 }) {
  if (!balance || balance.ok !== true || !portfolio || portfolio.ok !== true || balance.accountId !== expectedAccountId ||
      portfolio.accountId !== expectedAccountId || !Array.isArray(portfolio.contracts) ||
      !Array.isArray(valuations) || valuations.length !== portfolio.contracts.length) {
    return { ok: false, reason: "ACCOUNT_SNAPSHOT_MISMATCH_OR_INCOMPLETE" };
  }
  const balanceTime = Date.parse(balance.asOf);
  const portfolioTime = Date.parse(portfolio.asOf);
  if (!Number.isFinite(balanceTime) || !Number.isFinite(portfolioTime) ||
      now - balanceTime < -2000 || now - portfolioTime < -2000 ||
      now - balanceTime > maxAgeMs || now - portfolioTime > maxAgeMs) {
    return { ok: false, reason: "ACCOUNT_SNAPSHOT_STALE" };
  }
  const valuationMap = new Map(valuations.map((item) => [item?.contractId, item]));
  if (valuationMap.size !== portfolio.contracts.length || portfolio.contracts.some((contract) => {
    const valuation = valuationMap.get(contract.contractId);
    return contract.currency !== balance.currency || !valuation || valuation.ok !== true ||
      valuation.currency !== balance.currency || valuation.status !== "open" ||
      valuation.buyPrice !== contract.buyPrice;
  })) {
    return { ok: false, reason: "PORTFOLIO_CURRENCY_MISMATCH" };
  }
  return Object.freeze({
    ok: true,
    accountId: expectedAccountId,
    accountMode: "DEMO",
    balance: balance.balance,
    currency: balance.currency,
    openContracts: portfolio.contracts.map((contract) => ({
      ...contract,
      bidPrice: valuationMap.get(contract.contractId).bidPrice,
      profit: valuationMap.get(contract.contractId).profit,
      currentSpotTime: valuationMap.get(contract.contractId).currentSpotTime
    })),
    openContractCount: portfolio.contracts.length,
    balanceAsOf: balance.asOf,
    portfolioAsOf: portfolio.asOf,
    source: "DERIV_AUTHENTICATED_ACCOUNT_SESSION",
    realExecutionAuthorized: false
  });
}
