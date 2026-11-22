import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Server configuration incomplete." });
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Login session is invalid or expired." });
    }

    const { data, error } = await admin
      .from("deriv_connections")
      .select("deriv_account_id,accounts,token_expires_at,connected_at")
      .eq("user_id", auth.user.id)
      .maybeSingle();

    if (error) {
      console.error("Deriv account list lookup failed:", { code: error.code || null });
      return res.status(503).json({ error: "Could not load connected Deriv accounts." });
    }
    if (!data) return res.status(404).json({ error: "No Deriv connection found." });

    const expiry = data.token_expires_at ? Date.parse(data.token_expires_at) : 0;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return res.status(409).json({ error: "Deriv authorization expired. Reconnect to refresh your verified account list." });
    }

    const accounts = Array.isArray(data.accounts)
      ? data.accounts.filter((account) =>
          account && typeof account.account_id === "string" &&
          ["demo", "real"].includes(String(account.account_type || "").toLowerCase()) &&
          String(account.status || "active").toLowerCase() === "active"
        ).map((account) => ({
          account_id: account.account_id,
          account_type: String(account.account_type).toLowerCase(),
          currency: typeof account.currency === "string" ? account.currency : null,
          status: "active",
          group: typeof account.group === "string" ? account.group : null
        }))
      : [];

    return res.status(200).json({
      accounts,
      selected_account_id: data.deriv_account_id || null,
      token_expires_at: data.token_expires_at,
      connected_at: data.connected_at || null,
      real_trading_enabled: false
    });
  } catch (error) {
    console.error("Deriv accounts endpoint error:", { name: error?.name || null });
    return res.status(500).json({ error: "Could not load Deriv accounts." });
  }
}
