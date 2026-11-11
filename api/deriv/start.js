
import crypto from "node:crypto";

export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const clientId = process.env.DERIV_CLIENT_ID;
  const redirectUri = process.env.DERIV_REDIRECT_URI;
  const secret = process.env.DERIV_OAUTH_SECRET;

  if (!clientId || !redirectUri || !secret) {
    return res.status(503).send(
      "Deriv connection is not configured yet."
    );
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(32).toString("hex");

  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      verifier,
      state,
      expires: Date.now() + 10 * 60 * 1000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  res.setHeader("Set-Cookie",
    `deriv_oauth=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=600`
  );

  const url = new URL("https://auth.deriv.com/oauth2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "account_manage");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, url.toString());
}
