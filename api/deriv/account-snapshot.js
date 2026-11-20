import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "../../lib/encryption.js";
import { normalizeVerifiedDerivAccounts } from "../../lib/deriv-accounts.js";
import {
  normalizeDerivBalanceResponse,
  normalizeDerivPortfolioResponse,
  buildDerivAccountSnapshot
} from "../../lib/deriv/account-snapshot.js";
import { calculateDerivOptionsOpenStakeRisk } from "../../lib/deriv/options-portfolio-risk.js";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export async function fetchAccountScopedWsSnapshot(url, WebSocketImpl = globalThis.WebSocket) {
  if (typeof WebSocketImpl !== "function") throw new Error("WEBSOCKET_RUNTIME_UNAVAILABLE");
  const socket = new WebSocketImpl(url);
  return new Promise((resolve, reject) => {
    const responses = new Map();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("DERIV_ACCOUNT_WS_TIMEOUT")), 8000);
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ balance: 1, req_id: 7101 }));
        socket.send(JSON.stringify({ portfolio: 1, req_id: 7102 }));
      } catch {
        finish(new Error("DERIV_ACCOUNT_WS_SEND_FAILED"));
      }
    });
    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        finish(new Error("DERIV_ACCOUNT_WS_INVALID_JSON"));
        return;
      }
      const requestId = payload?.req_id;
      if (requestId !== 7101 && requestId !== 7102) return;
      if (payload.error) {
        finish(new Error("DERIV_ACCOUNT_WS_PROVIDER_ERROR"));
        return;
      }
      responses.set(requestId, payload);
      if (responses.has(7101) && responses.has(7102)) {
        finish(null, { balance: responses.get(7101), portfolio: responses.get(7102) });
      }
    });
    socket.addEventListener("error", () => finish(new Error("DERIV_ACCOUNT_WS_ERROR")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("DERIV_ACCOUNT_WS_CLOSED_EARLY"));
    });
  });
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
    if (balance.ok === false || portfolio.ok === false) {
      return res.status(502).json({ error: "Deriv returned incomplete or mismatched account data." });
    }
    const snapshot = buildDerivAccountSnapshot({
      balance, portfolio, expectedAccountId: accountId, now: Date.now(), maxAgeMs: 15000
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
