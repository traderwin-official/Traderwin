
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
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
    return res.status(503).json({
      error: "Server configuration incomplete."
    });
  }

  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Please log in first."
      });
    }

    const accessToken = authHeader.slice(7);

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

    const {
      data: { user },
      error
    } = await supabase.auth.getUser(accessToken);

    if (error || !user) {
      return res.status(401).json({
        error: "Invalid login session."
      });
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
        userId: user.id,
        expires: Date.now() + 10 * 60 * 1000
      })
    ).toString("base64url");

    const signature = crypto
      .createHmac("sha256", DERIV_OAUTH_SECRET)
      .update(payload)
      .digest("base64url");

    res.setHeader(
      "Set-Cookie",
      `deriv_oauth=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=600`
    );

    const authorizationUrl = new URL(
      "https://auth.deriv.com/oauth2/auth"
    );

    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", DERIV_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", DERIV_REDIRECT_URI);
    authorizationUrl.searchParams.set("scope", "account_manage");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set(
      "code_challenge_method",
      "S256"
    );

    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json({
      authorizationUrl: authorizationUrl.toString()
    });

  } catch (error) {
    return res.status(500).json({
      error: "Could not start Deriv connection."
    });
  }
}
