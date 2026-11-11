
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const clientId = process.env.DERIV_CLIENT_ID;
  const redirectUri = process.env.DERIV_REDIRECT_URI;
  const oauthSecret = process.env.DERIV_OAUTH_SECRET;

  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)deriv_oauth=([^;]+)/);

  function clearCookie() {
    res.setHeader(
      "Set-Cookie",
      "deriv_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=0"
    );
  }

  try {
    if (!clientId || !redirectUri || !oauthSecret) {
      return res.status(503).send("OAuth is not configured.");
    }

    if (!match) {
      return res.status(400).send("OAuth session missing. Please try again.");
    }

    const [payload, signature] = decodeURIComponent(match[1]).split(".");

    const expected = crypto
      .createHmac("sha256", oauthSecret)
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

    if (session.expires < Date.now()) {
      clearCookie();
      return res.status(400).send("OAuth session expired.");
    }

    const { code, state, error } = req.query;

    if (error) {
      clearCookie();
      return res.status(400).send("Deriv authorization was cancelled.");
    }

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      state !== session.state
    ) {
      clearCookie();
      return res.status(400).send("Invalid OAuth state.");
    }

    const response = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: session.verifier,
          redirect_uri: redirectUri
        })
      }
    );

    const tokenData = await response.json();

    if (!response.ok || !tokenData.access_token) {
      clearCookie();
      return res.status(400).send("Deriv token exchange failed.");
    }

    // Token received. Secure database storage is the next step.
    // Do not expose or log the access token.

    clearCookie();

    return res.status(200).send(
      "Deriv authorization successful. Secure account storage is pending."
    );

  } catch (err) {
    clearCookie();
    return res.status(500).send("Deriv callback processing failed.");
  }
}
