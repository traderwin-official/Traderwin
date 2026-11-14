import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { encryptToken } from "../../lib/encryption.js";

function safeAccounts(payload) {
  const raw = Array.isArray(payload?.data)
    ? payload.data
    : payload?.data && typeof payload.data === "object"
      ? [payload.data]
      : [];

  return raw
    .filter((account) =>
      account &&
      typeof account.account_id === "string" &&
      account.account_id.length > 0 &&
      typeof account.account_type === "string"
    )
    .map((account) => ({
      account_id: account.account_id,
      account_type: account.account_type,
      currency: typeof account.currency === "string" ? account.currency : null,
      status: typeof account.status === "string" ? account.status : null,
      group: typeof account.group === "string" ? account.group : null
    }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const {
    DERIV_CLIENT_ID,
    DERIV_REDIRECT_URI,
    DERIV_OAUTH_SECRET,
    TOKEN_ENCRYPTION_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\\s*)deriv_oauth=([^;]+)/);

  const clearCookie = () => {
    res.setHeader(
      "Set-Cookie",
      "deriv_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    );
  };

  const finish = (status) => {
    clearCookie();
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(303, "/?deriv=" + status);
  };

  try {
    if (
      !DERIV_CLIENT_ID ||
      !DERIV_REDIRECT_URI ||
      !DERIV_OAUTH_SECRET ||
      !TOKEN_ENCRYPTION_KEY ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      console.error("Deriv callback configuration incomplete.");
      return finish("error");
    }

    if (!match) return finish("error");

    const cookieValue = decodeURIComponent(match[1]);
    const separator = cookieValue.lastIndexOf(".");
    if (separator === -1) return finish("error");

    const payload = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    const expected = crypto
      .createHmac("sha256", DERIV_OAUTH_SECRET)
      .update(payload)
      .digest();
    const received = Buffer.from(signature, "base64url");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) return finish("error");

    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !session.userId ||
      !session.state ||
      !session.verifier ||
      !Number.isFinite(session.expires) ||
      session.expires < Date.now()
    ) return finish("error");

    const { code, state, error } = req.query;
    if (error) return finish("cancelled");
    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      state !== session.state
    ) return finish("error");

    const tokenResponse = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: DERIV_CLIENT_ID,
        code,
        code_verifier: session.verifier,
        redirect_uri: DERIV_REDIRECT_URI
      })
    });

    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (
      !tokenResponse.ok ||
      typeof tokenData.access_token !== "string" ||
      !Number.isFinite(Number(tokenData.expires_in)) ||
      Number(tokenData.expires_in) <= 0
    ) {
      console.error("Deriv token exchange failed or omitted expiry.");
      return finish("error");
    }

    // Verify the delegated token against Deriv before reporting a connection.
    const accountsResponse = await fetch(
      "https://api.derivws.com/trading/v1/options/accounts",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json"
        }
      }
    );
    const accountsPayload = await accountsResponse.json().catch(() => ({}));
    if (!accountsResponse.ok) {
      console.error("Deriv account verification failed:", accountsResponse.status);
      return finish("error");
    }

    const accounts = safeAccounts(accountsPayload);
    if (accounts.length === 0) {
      console.error("Deriv returned no verifiable Options accounts.");
      return finish("error");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const now = new Date();
    const tokenExpiresAt = new Date(
      now.getTime() + Number(tokenData.expires_in) * 1000
    ).toISOString();

    const { error: saveError } = await supabase
      .from("deriv_connections")
      .upsert({
        user_id: session.userId,
        deriv_account_id: null,
        encrypted_access_token: encryptToken(tokenData.access_token),
        token_expires_at: tokenExpiresAt,
        token_type: typeof tokenData.token_type === "string" ? tokenData.token_type : "Bearer",
        requested_scopes: ["trade", "account_manage"],
        accounts,
        connected_at: now.toISOString(),
        updated_at: now.toISOString()
      }, { onConflict: "user_id" });

    if (saveError) {
      console.error("Deriv connection save failed:", saveError.code || "database_error");
      return finish("error");
    }

    return finish("connected");
  } catch (error) {
    console.error("Deriv callback processing failed:", error.message);
    return finish("error");
  }
}
