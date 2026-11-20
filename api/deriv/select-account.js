import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

  const accountId = req.body?.account_id;
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 128) {
    return res.status(400).json({ error: "Choose a valid DEMO account." });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Login session is invalid or expired." });
    }

    const { data: connection, error: lookupError } = await admin
      .from("deriv_connections")
      .select("accounts,token_expires_at")
      .eq("user_id", auth.user.id)
      .maybeSingle();

    if (lookupError) {
      console.error("Deriv selection validation failed:", { code: lookupError.code || null });
      return res.status(503).json({ error: "Could not validate account selection." });
    }
    if (!connection) return res.status(404).json({ error: "No Deriv connection found." });

    const expiry = connection.token_expires_at ? Date.parse(connection.token_expires_at) : 0;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return res.status(409).json({ error: "Deriv authorization expired. Reconnect before selecting an account." });
    }

    const allowed = Array.isArray(connection.accounts) && connection.accounts.some((account) =>
      account && account.account_id === accountId &&
      String(account.account_type || "").toLowerCase() === "demo" &&
      String(account.status || "active").toLowerCase() === "active"
    );
    if (!allowed) {
      return res.status(403).json({
        error: "Only a verified active DEMO account can be selected. REAL accounts remain locked."
      });
    }

    const { error: updateError } = await admin
      .from("deriv_connections")
      .update({
        deriv_account_id: accountId,
        demo_account_id: accountId,
        updated_at: new Date().toISOString()
      })
      .eq("user_id", auth.user.id);

    if (updateError) {
      console.error("Deriv account selection save failed:", { code: updateError.code || null });
      return res.status(503).json({ error: "Could not save selected DEMO account." });
    }

    return res.status(200).json({
      selected_account_id: accountId,
      message: "DEMO account selected. Automation remains off and REAL trading remains locked."
    });
  } catch (error) {
    console.error("Deriv account selection endpoint error:", { name: error?.name || null });
    return res.status(500).json({ error: "Could not save account selection." });
  }
}
