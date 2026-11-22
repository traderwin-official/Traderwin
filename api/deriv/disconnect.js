import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

    const { error } = await admin
      .from("deriv_connections")
      .delete()
      .eq("user_id", auth.user.id);

    if (error) {
      console.error("Deriv disconnect failed:", error.message);
      return res.status(503).json({ error: "Could not disconnect Deriv right now." });
    }

    return res.status(200).json({ disconnected: true });
  } catch (error) {
    console.error("Deriv disconnect error:", error.message);
    return res.status(500).json({ error: "Could not disconnect Deriv." });
  }
}
