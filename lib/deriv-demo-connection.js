export function isVerifiedActiveDerivDemoConnection(connection, now = Date.now()) {
  if (!connection || typeof connection !== "object" ||
      typeof connection.demo_account_id !== "string" || !connection.demo_account_id.trim() ||
      !Number.isFinite(now)) return false;
  const expiry = Date.parse(connection.token_expires_at || "");
  if (!Number.isFinite(expiry) || expiry <= now) return false;
  return Array.isArray(connection.accounts) && connection.accounts.some(account =>
    account && account.account_id === connection.demo_account_id &&
    String(account.account_type || "").toLowerCase() === "demo" &&
    String(account.status || "active").toLowerCase() === "active"
  );
}
