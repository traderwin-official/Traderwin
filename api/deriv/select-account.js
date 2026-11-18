import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

  const accountId = req.body?.account_id;
  if (typeof accountId !== "string" || accountId.length < 1 || accountId.length > 128) {
    return res.status(400).json({ error: "Choose a valid DEMO account." });
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

    const { data: connection, error: lookupError } = await supabase
      .from("deriv_connections")
      .select("accounts")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (lookupError) {
      console.error("Deriv selection validation failed:", { code: lookupError.code || null });
      return res.status(500).json({ error: "Could not validate account selection." });
    }
    if (!connection) return res.status(404).json({ error: "No Deriv connection found." });

    const accounts = Array.isArray(connection.accounts) ? connection.accounts : [];
    const allowed = accounts.find((account) =>
      account && account.account_id === accountId &&
      typeof account.account_type === "string" &&
      account.account_type.toLowerCase() === "demo"
    );
    if (!allowed) {
      return res.status(403).json({ error: "Only verified DEMO accounts can be selected at this stage. REAL accounts remain locked." });
    }

    const { error: updateError } = await supabase
      .from("deriv_connections")
      .update({ deriv_account_id: accountId, updated_at: new Date().toISOString() })
      .eq("user_id", userData.user.id);

    if (updateError) {
      console.error("Deriv account selection save failed:", { code: updateError.code || null });
      return res.status(500).json({ error: "Could not save selected DEMO account." });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ selected_account_id: accountId, message: "DEMO account selected. Trading automation remains off." });
  } catch (error) {
    console.error("Deriv account selection endpoint error:", { name: error?.name || null });
    return res.status(500).json({ error: "Could not save account selection." });
  }
}
