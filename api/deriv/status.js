import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Server configuration incomplete." });
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }

    const { data, error } = await admin
      .from("deriv_connections")
      .select("deriv_account_id,demo_account_id,real_account_id,token_expires_at,updated_at")
      .eq("user_id", auth.user.id)
      .maybeSingle();

    if (error) {
      console.error("Deriv status lookup failed:", error.message);
      return res.status(503).json({ error: "Deriv connection status is temporarily unavailable." });
    }

    const tokenExpiresAt = data?.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
    const tokenValid = Number.isFinite(tokenExpiresAt) && tokenExpiresAt > Date.now();
    return res.status(200).json({
      connected: Boolean(data?.demo_account_id && tokenValid),
      demoAccountId: data?.demo_account_id || null,
      realAccountId: data?.real_account_id || null,
      tokenValid,
      tokenExpiresAt: data?.token_expires_at || null,
      connectedAt: data?.updated_at || null
    });
  } catch (error) {
    console.error("Deriv status error:", error.message);
    return res.status(500).json({ error: "Could not check Deriv connection." });
  }
}
