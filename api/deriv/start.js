
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

  if (!DERIV_CLIENT_ID || !DERIV_REDIRECT_URI ||
      !DERIV_OAUTH_SECRET || !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      error: "Server configuration incomplete."
    });
  }

  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing Supabase access token."
      });
    }

    const accessToken = authHeader.slice(7).trim();

    if (!accessToken) {
      return res.status(401).json({
        error: "Empty Supabase access token."
      });
    }

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

    const { data, error } =
      await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      console.error("Deriv start authentication failed:", {
        status: error?.status || null,
        code: error?.code || null,
        message: error?.message || "No user returned"
      });

      return res.status(401).json({
        error: "Supabase rejected the login session. Check that Vercel SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY belong to the same project as the frontend."
      });
    }

    const verifier = crypto.randomBytes(32).toString("base64url");
    const state = crypto.randomBytes(32).toString("hex");

    const challenge = crypto.createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const payload = Buffer.from(JSON.stringify({
      verifier,
      state,
      userId: data.user.id,
      expires: Date.now() + 600000
    })).toString("base64url");

    const signature = crypto.createHmac(
      "sha256",
      DERIV_OAUTH_SECRET
    ).update(payload).digest("base64url");

    res.setHeader(
      "Set-Cookie",
      `deriv_oauth=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    );

    const url = new URL("https://auth.deriv.com/oauth2/auth");

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", DERIV_CLIENT_ID);
    url.searchParams.set("redirect_uri", DERIV_REDIRECT_URI);
    url.searchParams.set("scope", "trade account_manage");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      authorizationUrl: url.toString()
    });

  } catch (error) {
    console.error("Deriv start failure:", {
      message: error.message
    });

    return res.status(500).json({
      error: "Could not start Deriv connection."
    });
  }
}
