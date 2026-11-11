
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { encryptToken } from "../lib/encryption.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
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

  try {
    if (
      !DERIV_CLIENT_ID ||
      !DERIV_REDIRECT_URI ||
      !DERIV_OAUTH_SECRET ||
      !TOKEN_ENCRYPTION_KEY ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return res.status(503).send("Server configuration incomplete.");
    }

    if (!match) {
      return res.status(400).send("OAuth session missing. Try again.");
    }

    const [payload, signature] = decodeURIComponent(match[1]).split(".");

    const expected = crypto
      .createHmac("sha256", DERIV_OAUTH_SECRET)
      .update(payload)
      .digest();

    const received = Buffer.from(signature || "", "base64url");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      clearCookie();
      return res.status(400).send("Invalid OAuth session.");
    }

    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    if (!session.userId || session.expires < Date.now()) {
      clearCookie();
      return res.status(400).send("OAuth session expired.");
    }

    const { code, state, error } = req.query;

    if (error) {
      clearCookie();
      return res.status(400).send("Deriv authorization cancelled.");
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      state !== session.state
    ) {
      clearCookie();
      return res.status(400).send("Invalid OAuth state.");
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

    if (!tokenResponse.ok || !tokenData.access_token) {
      clearCookie();
      return res.status(400).send("Deriv token exchange failed.");
    }

    const encryptedToken = encryptToken(tokenData.access_token);

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    const { error: saveError } = await supabase
      .from("deriv_connections")
      .upsert({
        user_id: session.userId,
        deriv_account_id: tokenData.account_id
          ? String(tokenData.account_id)
          : null,
        encrypted_access_token: encryptedToken,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "user_id"
      });

    if (saveError) {
      throw saveError;
    }

    clearCookie();
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(
      "Deriv account connected and securely saved to TRADERWIN."
    );

  } catch (err) {
    clearCookie();
    return res.status(500).send("Could not save Deriv connection.");
  }
}
