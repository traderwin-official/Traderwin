
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Encrypt Deriv access tokens using AES-256-GCM.
function encryptToken(token) {
  const key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Invalid token encryption key configuration.");
  }

  const encryptionKey = Buffer.from(key, "hex");
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
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
  const match = cookie.match(/(?:^|;\s*)deriv_oauth=([^;]+)/);

  const clearCookie = () => {
    res.setHeader(
      "Set-Cookie",
      "deriv_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=0"
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

    if (!match) {
      return finish("error");
    }

    const cookieValue = decodeURIComponent(match[1]);
    const separator = cookieValue.lastIndexOf(".");

    if (separator === -1) {
      return finish("error");
    }

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
    ) {
      return finish("error");
    }

    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (
      !session.userId ||
      !session.state ||
      !session.verifier ||
      !Number.isFinite(session.expires) ||
      session.expires < Date.now()
    ) {
      return finish("error");
    }

    const { code, state, error } = req.query;

    if (error) {
      return finish("cancelled");
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      state !== session.state
    ) {
      return finish("error");
    }

    const tokenResponse = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: DERIV_CLIENT_ID,
          code,
          code_verifier: session.verifier,
          redirect_uri: DERIV_REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token ||
        !Number.isFinite(Number(tokenData.expires_in)) || Number(tokenData.expires_in) <= 0) {
      console.error("Deriv token exchange failed or returned no valid expiry.");
      return finish("error");
    }

    // Verify the user's actual Deriv accounts before marking the connection complete.
    const accountsResponse = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
      signal: AbortSignal.timeout(12000)
    });
    const accountsPayload = await accountsResponse.json().catch(() => ({}));
    const rawAccounts = Array.isArray(accountsPayload.data)
      ? accountsPayload.data
      : Array.isArray(accountsPayload.data?.accounts) ? accountsPayload.data.accounts : [];
    if (!accountsResponse.ok || !rawAccounts.length) {
      console.error("Deriv account verification failed.");
      return finish("error");
    }
    const eligible = rawAccounts.filter(account => {
      const status = String(account.status || "active").toLowerCase();
      return account && account.account_id && status === "active";
    });
    const demoAccount = eligible.find(account =>
      String(account.account_type || account.type || "").toLowerCase() === "demo"
    );
    const realAccount = eligible.find(account =>
      String(account.account_type || account.type || "").toLowerCase() === "real"
    );
    if (!demoAccount) {
      console.error("Deriv did not return an active demo account.");
      return finish("error");
    }

    const encryptedToken = encryptToken(tokenData.access_token);
    const tokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString();

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const { error: saveError } = await supabase
      .from("deriv_connections")
      .upsert(
        {
          user_id: session.userId,
          deriv_account_id: String(demoAccount.account_id),
          demo_account_id: String(demoAccount.account_id),
          real_account_id: realAccount ? String(realAccount.account_id) : null,
          token_expires_at: tokenExpiresAt,
          encrypted_access_token: encryptedToken,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "user_id"
        }
      );

    if (saveError) {
      console.error("Deriv connection save failed.");
      return finish("error");
    }

    return finish("connected");

  } catch (error) {
    console.error(
      "Deriv callback processing failed:",
      error.message
    );

    return finish("error");
  }
}
