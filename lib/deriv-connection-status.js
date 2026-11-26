export function evaluateDerivConnectionStatus(connection, now = Date.now()) {
  const expiresAt = connection?.token_expires_at
    ? Date.parse(connection.token_expires_at)
    : 0;
  const tokenValid = Number.isFinite(expiresAt) && expiresAt > now;
  const demoAccountId = typeof connection?.demo_account_id === "string"
    ? connection.demo_account_id
    : null;
  const accounts = Array.isArray(connection?.accounts) ? connection.accounts : [];
  const verifiedDemoAccount = Boolean(
    demoAccountId && accounts.some((account) =>
      account &&
      account.account_id === demoAccountId &&
      String(account.account_type || "").toLowerCase() === "demo" &&
      String(account.status || "active").toLowerCase() === "active"
    )
  );
  const connected = tokenValid && verifiedDemoAccount;

  return {
    hasConnection: Boolean(connection),
    connected,
    connectionState: connected
      ? "CONNECTED"
      : !connection
        ? "NOT_CONNECTED"
        : !tokenValid
          ? "AUTHORIZATION_EXPIRED"
          : "DEMO_ACCOUNT_REQUIRES_REVERIFICATION",
    demoAccountVerified: verifiedDemoAccount,
    demoAccountId: connected ? demoAccountId : null,
    tokenValid,
    tokenExpiresAt: connection?.token_expires_at || null,
    connectedAt: connection?.connected_at || connection?.updated_at || null,
    realAccountAvailable: accounts.some((account) =>
      account &&
      String(account.account_type || "").toLowerCase() === "real" &&
      String(account.status || "active").toLowerCase() === "active"
    ),
    realTradingEnabled: false
  };
}
