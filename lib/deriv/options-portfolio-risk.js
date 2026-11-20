/**
 * Conservative exposure summary for Deriv Options positions only.
 * Sum of provider-reported purchase prices is the open stake at risk.
 * This is not MT5/CFD notional, margin, or stop-loss risk.
 */
export function calculateDerivOptionsOpenStakeRisk(snapshot) {
  if (!snapshot || snapshot.ok !== true || snapshot.accountMode !== "DEMO" ||
      typeof snapshot.accountId !== "string" || !/^[A-Za-z0-9]{5,32}$/.test(snapshot.accountId) ||
      !/^[A-Z]{3}$/.test(snapshot.currency || "") ||
      !Number.isFinite(snapshot.balance) || snapshot.balance < 0 ||
      !Array.isArray(snapshot.openContracts)) {
    return { ok: false, status: "BLOCKED", reason: "ACCOUNT_SNAPSHOT_INVALID" };
  }

  let stakeAtRisk = 0;
  const seen = new Set();
  for (const contract of snapshot.openContracts) {
    if (!contract || !Number.isSafeInteger(contract.contractId) || contract.contractId <= 0 ||
        seen.has(contract.contractId) || contract.currency !== snapshot.currency ||
        !Number.isFinite(contract.buyPrice) || contract.buyPrice < 0) {
      return { ok: false, status: "BLOCKED", reason: "OPEN_CONTRACT_RISK_DATA_INVALID" };
    }
    seen.add(contract.contractId);
    stakeAtRisk += contract.buyPrice;
    if (!Number.isFinite(stakeAtRisk)) {
      return { ok: false, status: "BLOCKED", reason: "OPEN_STAKE_RISK_OVERFLOW" };
    }
  }

  return Object.freeze({
    ok: true,
    status: "READ_ONLY_RISK_SNAPSHOT",
    accountId: snapshot.accountId,
    accountMode: "DEMO",
    currency: snapshot.currency,
    openContractCount: snapshot.openContracts.length,
    openStakeAtRisk: stakeAtRisk,
    balance: snapshot.balance,
    balanceRatio: snapshot.balance > 0 ? stakeAtRisk / snapshot.balance : null,
    riskBasis: "SUM_OF_PROVIDER_REPORTED_OPTIONS_BUY_PRICE",
    source: "DERIV_AUTHENTICATED_ACCOUNT_SESSION",
    executionAuthorized: false
  });
}
