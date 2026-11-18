import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Server configuration incomplete." });
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const accessToken = authHeader.slice(7).trim();
    const { data: userData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !userData.user) {
      return res.status(401).json({ error: "Login session is invalid or expired." });
    }

    const { data, error } = await supabase
      .from("deriv_connections")
      .select("deriv_account_id, accounts, token_expires_at, connected_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (error) {
      console.error("Deriv account list lookup failed:", { code: error.code || null });
      return res.status(500).json({ error: "Could not load connected Deriv accounts." });
    }
    if (!data) return res.status(404).json({ error: "No Deriv connection found." });
    if (!data.token_expires_at || Date.parse(data.token_expires_at) <= Date.now()) {
      return res.status(409).json({ error: "Deriv authorization expired. Reconnect your account to refresh its verified account list." });
    }

    const accounts = Array.isArray(data.accounts) ? data.accounts.filter((account) =>
      account && typeof account.account_id === "string" &&
      typeof account.account_type === "string"
    ).map((account) => ({
      account_id: account.account_id,
      account_type: account.account_type,
      currency: typeof account.currency === "string" ? account.currency : null,
      status: typeof account.status === "string" ? account.status : null,
      group: typeof account.group === "string" ? account.group : null
    })) : [];

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      accounts,
      selected_account_id: data.deriv_account_id || null,
      token_expires_at: data.token_expires_at || null,
      connected_at: data.connected_at || null
    });
  } catch (error) {
    console.error("Deriv accounts endpoint error:", { name: error?.name || null });
    return res.status(500).json({ error: "Could not load Deriv accounts." });
  }
}
