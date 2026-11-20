import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "../../lib/encryption.js";
import { normalizeVerifiedDerivAccounts } from "../../lib/deriv-accounts.js";
import {
  normalizeDerivContractsForResponse,
  buildDerivProposalRequest,
  normalizeDerivProposalResponse
} from "../../lib/deriv/options-contract-adapter.js";
import { fetchDerivProposalSession } from "../../lib/deriv/proposal-session-websocket.js";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

function requestBody(body) {
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

  const body = requestBody(req.body);
  if (!body || typeof body.symbol !== "string" ||
      !/^[A-Za-z0-9_]{2,30}$/.test(body.symbol) ||
      typeof body.contract_type !== "string" ||
      !/^[A-Z]{3,24}$/.test(body.contract_type) ||
      typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0 ||
      !["stake", "payout"].includes(body.basis) ||
      !Number.isSafeInteger(body.duration) || body.duration <= 0 ||
      (body.duration_unit !== undefined && !["s", "m", "h", "d", "t"].includes(body.duration_unit)) ||
      (body.barrier !== undefined && typeof body.barrier !== "string") ||
      (body.barrier2 !== undefined && typeof body.barrier2 !== "string")) {
    return res.status(400).json({ error: "Invalid DEMO proposal request." });
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
      console.error("Deriv proposal connection lookup failed:", { code: dbError.code || null });
      return res.status(503).json({ error: "Deriv proposal service is temporarily unavailable." });
    }
    if (!connection?.encrypted_access_token || !connection.demo_account_id) {
      return res.status(409).json({ error: "Select a verified DEMO account before requesting a proposal." });
    }
    const expiry = Date.parse(connection.token_expires_at || "");
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return res.status(409).json({ error: "Deriv authorization expired. Reconnect before continuing." });
    }

    const accountId = connection.demo_account_id;
    const savedAccount = Array.isArray(connection.accounts) && connection.accounts.find((account) =>
      account?.account_id === accountId && String(account.account_type).toLowerCase() === "demo" &&
      String(account.status || "active").toLowerCase() === "active" &&
      typeof account.currency === "string"
    );
    if (!savedAccount) return res.status(403).json({ error: "Selected account is not a verified active DEMO account with a known currency." });

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
      account.account_id === accountId && account.account_type === "demo" &&
      account.status === "active" && account.currency === savedAccount.currency
    );
    if (!verified || !/^[A-Za-z]{3}$/.test(verified.currency || "")) {
      return res.status(403).json({ error: "Deriv no longer verifies the selected DEMO account and currency." });
    }

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

    const session = await fetchDerivProposalSession(
      parsedWsUrl.toString(),
      body.symbol,
      (cataloguePayload) => {
        const metadata = normalizeDerivContractsForResponse(cataloguePayload, body.symbol);
        if (!metadata.ok) return null;
        const built = buildDerivProposalRequest({
          metadata,
          symbol: body.symbol,
          contractType: body.contract_type,
          currency: verified.currency,
          amount: body.amount,
          basis: body.basis,
          duration: body.duration,
          durationUnit: body.duration_unit || "s",
          barrier: body.barrier,
          barrier2: body.barrier2,
          reqId: 8301
        });
        return built.ok ? built.request : null;
      }
    );
    const normalized = normalizeDerivProposalResponse(
      session.proposal, session.request, { now: () => Date.now(), maxSpotAgeSeconds: 10 }
    );
    if (!normalized.ok) {
      return res.status(502).json({ error: "Deriv proposal failed provider validation or quote freshness checks." });
    }

    return res.status(200).json({
      account_id: accountId,
      account_mode: "DEMO",
      currency: normalized.currency,
      symbol: normalized.symbol,
      contract_type: normalized.contractType,
      amount: normalized.requestedAmount,
      amount_basis: normalized.amountBasis,
      ask_price: normalized.askPrice,
      payout: normalized.payout,
      spot: normalized.spot,
      spot_time: normalized.spotTime,
      date_start: normalized.dateStart,
      date_expiry: normalized.dateExpiry,
      longcode: normalized.longcode,
      provider_stake_limits: normalized.stakeLimits,
      stake_within_provider_limits: normalized.stakeWithinProviderLimits,
      sizing_authorized: false,
      execution_authorized: false,
      real_trading_enabled: false,
      note: "Read-only price proposal. No contract was purchased and no order was sent."
    });
  } catch (error) {
    console.error("Deriv DEMO proposal failed:", { name: error?.name || null, code: error?.message || null });
    return res.status(503).json({ error: "Could not obtain a trusted Deriv DEMO proposal." });
  }
}
