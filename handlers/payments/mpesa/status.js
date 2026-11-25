import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Payment status is temporarily unavailable." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in is required." });
  }
  const orderId = String(req.query?.orderId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    return res.status(400).json({ error: "A valid payment order ID is required." });
  }
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } =
      await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }
    const { data, error } = await admin.from("payment_orders")
      .select("id,service_code,amount_kes,currency,status,created_at,confirmed_at")
      .eq("id", orderId).eq("user_id", auth.user.id).maybeSingle();
    if (error) {
      console.error("Payment status lookup failed:", error.message);
      return res.status(503).json({ error: "Payment status is temporarily unavailable." });
    }
    if (!data) return res.status(404).json({ error: "Payment order was not found." });
    return res.status(200).json({ order: data });
  } catch (error) {
    console.error("Payment status error:", error.message);
    return res.status(500).json({ error: "Could not check payment status." });
  }
}
