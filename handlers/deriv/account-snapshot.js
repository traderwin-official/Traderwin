import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "../../lib/encryption.js";
import { normalizeVerifiedDerivAccounts } from "../../lib/deriv-accounts.js";
import {
  normalizeDerivBalanceResponse,
  normalizeDerivPortfolioResponse,
  normalizeDerivOpenContractValuation,
  buildDerivAccountSnapshot
} from "../../lib/deriv/account-snapshot.js";
import { calculateDerivOptionsOpenStakeRisk } from "../../lib/deriv/options-portfolio-risk.js";
import { fetchAccountScopedWsSnapshot } from "../../lib/deriv/account-snapshot-websocket.js";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !process.env.TOKEN_ENCRYPTION_KEY) {
    return res.status(503).json({ error: "Server configuration incomplete." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ") || !header.slice(7).trim()) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Login session is invalid or expired." });

    const { data: connection, error: dbError } = await admin
      .from("deriv_connections")
      .select("encrypted_access_token,demo_account_id,token_expires_at,accounts")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (dbError) {
      console.error("Deriv account snapshot lookup failed:", { code: dbError.code || null });
      return res.status(503).json({ error: "Account snapshot is temporarily unavailable." });
    }
    if (!connection?.encrypted_access_token || !connection.demo_account_id) {
      return res.status(409).json({ error: "Select a verified DEMO account before requesting its account snapshot." });
    }
    const expiry = Date.parse(connection.token_expires_at || "");
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return res.status(409).json({ error: "Deriv authorization expired. Reconnect before continuing." });
    }

    const accountId = connection.demo_account_id;
    const savedAccount = Array.isArray(connection.accounts) && connection.accounts.find((account) =>
      account?.account_id === accountId && String(account.account_type).toLowerCase() === "demo" &&
      String(account.status || "active").toLowerCase() === "active"
    );
    if (!savedAccount) return res.status(403).json({ error: "Selected account is not in the verified active DEMO account list." });

    const accessToken = decryptToken(connection.encrypted_access_token);
    const accountsResponse = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    const accountsPayload = await readJson(accountsResponse);
    if (!accountsResponse.ok) {
      return res.status(accountsResponse.status === 401 ? 409 : 503).json({
        error: accountsResponse.status === 401 ? "Deriv authorization expired. Reconnect." : "Deriv account verification is unavailable."
      });
    }
    const verified = normalizeVerifiedDerivAccounts(accountsPayload).find((account) =>
      account.account_id === accountId && account.account_type === "demo" && account.status === "active"
    );
    if (!verified) return res.status(403).json({ error: "Deriv no longer verifies the selected account as active DEMO." });

    const otpResponse = await fetch(
      "https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(accountId) + "/otp",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      }
    );
    const otpPayload = await readJson(otpResponse);
    const wsUrl = otpPayload?.data?.url;
    if (!otpResponse.ok || typeof wsUrl !== "string") {
      return res.status(503).json({ error: "Could not open a verified Deriv DEMO account session." });
    }
    let parsedWsUrl;
    try { parsedWsUrl = new URL(wsUrl); } catch { parsedWsUrl = null; }
    if (!parsedWsUrl || parsedWsUrl.protocol !== "wss:" ||
        parsedWsUrl.hostname !== "api.derivws.com" ||
        parsedWsUrl.pathname !== "/trading/v1/options/ws/demo" ||
        !parsedWsUrl.searchParams.has("otp")) {
      return res.status(502).json({ error: "Deriv returned an invalid DEMO WebSocket endpoint." });
    }

    const raw = await fetchAccountScopedWsSnapshot(parsedWsUrl.toString());
    const receivedAt = new Date().toISOString();
    const balance = normalizeDerivBalanceResponse(raw.balance, accountId, receivedAt);
    const portfolio = normalizeDerivPortfolioResponse(raw.portfolio, accountId, receivedAt);
    if (balance.ok === false || portfolio.ok === false || !Array.isArray(raw.valuations) ||
        raw.valuations.length !== portfolio.contracts.length) {
      return res.status(502).json({ error: "Deriv returned incomplete or mismatched account data." });
    }
    const valuationNow = Date.now();
    const valuations = raw.valuations.map((payload, index) =>
      normalizeDerivOpenContractValuation(payload, portfolio.contracts[index]?.contractId, {
        now: valuationNow, maxAgeSeconds: 30
      })
    );
    if (valuations.some((item) => item.ok !== true)) {
      return res.status(502).json({ error: "Deriv returned a stale or mismatched open-contract valuation." });
    }
    const snapshot = buildDerivAccountSnapshot({
      balance, portfolio, valuations, expectedAccountId: accountId, now: valuationNow, maxAgeMs: 15000
    });
    if (!snapshot.ok) return res.status(502).json({ error: "Deriv account snapshot failed freshness or consistency checks." });

    const openRisk = calculateDerivOptionsOpenStakeRisk(snapshot);
    if (!openRisk.ok) return res.status(502).json({ error: "Deriv open-position risk data is incomplete." });

    return res.status(200).json({
      account: {
        account_id: snapshot.accountId,
        account_mode: snapshot.accountMode,
        balance: snapshot.balance,
        currency: snapshot.currency,
        open_contract_count: snapshot.openContractCount,
        open_contracts: snapshot.openContracts,
        balance_as_of: snapshot.balanceAsOf,
        portfolio_as_of: snapshot.portfolioAsOf,
        source: snapshot.source,
        open_stake_at_risk: openRisk.openStakeAtRisk,
        open_unrealized_profit: openRisk.openUnrealizedProfit,
        open_stake_risk_ratio: openRisk.balanceRatio,
        risk_basis: openRisk.riskBasis
      },
      real_trading_enabled: false,
      execution_authorized: false
    });
  } catch (error) {
    console.error("Deriv account snapshot failed:", { name: error?.name || null, code: error?.message || null });
    return res.status(503).json({ error: "Could not obtain a trusted Deriv DEMO account snapshot." });
  }
}
