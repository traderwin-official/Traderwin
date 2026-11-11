
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const {
    DERIV_CLIENT_ID,
    DERIV_REDIRECT_URI,
    DERIV_OAUTH_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  if (
    !DERIV_CLIENT_ID ||
    !DERIV_REDIRECT_URI ||
    !DERIV_OAUTH_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(503).send("Server configuration incomplete.");
  }

  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).send("Please log in first.");
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error } =
      await supabase.auth.getUser(authHeader.slice(7));

    if (error || !user) {
      return res.status(401).send("Invalid login session.");
    }

    const verifier = crypto.randomBytes(32).toString("base64url");
    const state = crypto.randomBytes(32).toString("hex");

    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const payload = Buffer.from(JSON.stringify({
      verifier,
      state,
      userId: user.id,
      expires: Date.now() + 10 * 60 * 1000
    })).toString("base64url");

    const signature = crypto
      .createHmac("sha256", DERIV_OAUTH_SECRET)
      .update(payload)
      .digest("base64url");

    res.setHeader(
      "Set-Cookie",
      `deriv_oauth=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=600`
    );

    const url = new URL("https://auth.deriv.com/oauth2/auth");

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", DERIV_CLIENT_ID);
    url.searchParams.set("redirect_uri", DERIV_REDIRECT_URI);
    url.searchParams.set("scope", "account_manage");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());

  } catch (error) {
    return res.status(500).send("Could not start Deriv connection.");
  }
}
