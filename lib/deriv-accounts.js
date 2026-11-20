// Normalize only provider-verified Deriv account metadata for server-side storage.
// Never return or persist access tokens through this module.
export function normalizeVerifiedDerivAccounts(payload) {
  const raw = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.data?.accounts)
      ? payload.data.accounts
      : Array.isArray(payload?.accounts)
        ? payload.accounts
        : payload?.data && typeof payload.data === "object"
          ? [payload.data]
          : [];

  const seen = new Set();
  return raw
    .filter((account) => account && typeof account === "object")
    .map((account) => {
      const accountId = typeof account.account_id === "string"
        ? account.account_id.trim()
        : "";
      const accountType = typeof account.account_type === "string"
        ? account.account_type.trim().toLowerCase()
        : typeof account.type === "string"
          ? account.type.trim().toLowerCase()
          : "";
      const status = typeof account.status === "string"
        ? account.status.trim().toLowerCase()
        : "active";
      return {
        account_id: accountId,
        account_type: accountType,
        currency: typeof account.currency === "string" ? account.currency : null,
        status,
        group: typeof account.group === "string" ? account.group : null
      };
    })
    .filter((account) => {
      if (!account.account_id || !["demo", "real"].includes(account.account_type) ||
          account.status !== "active" || seen.has(account.account_id)) return false;
      seen.add(account.account_id);
      return true;
    });
}

export function selectUnambiguousAccountId(accounts, accountType) {
  if (!Array.isArray(accounts) || !["demo", "real"].includes(accountType)) return null;
  const matches = accounts.filter((account) =>
    account && account.account_type === accountType && account.status === "active"
  );
  return matches.length === 1 ? matches[0].account_id : null;
}
