import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Subscription service is not configured." });
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
    const { data, error } = await admin.from("user_subscriptions")
      .select("service_code,status,starts_at,ends_at,payment_order_id")
      .eq("user_id", auth.user.id)
      .eq("service_code", "REAL_TRADING")
      .maybeSingle();
    if (error) {
      console.error("Subscription status lookup failed:", error.message);
      return res.status(503).json({ error: "Could not load subscription status." });
    }
    const now = Date.now();
    const end = data?.ends_at ? new Date(data.ends_at).getTime() : null;
    const active = data?.status === "ACTIVE" && Number.isFinite(end) && end > now;
    return res.status(200).json({
      serviceCode: "REAL_TRADING",
      status: active ? "ACTIVE" : data?.status === "ACTIVE" ? "EXPIRED" : (data?.status || "NOT_PURCHASED"),
      active,
      startsAt: data?.starts_at || null,
      endsAt: data?.ends_at || null,
      renewalMode: "MANUAL",
      realExecutionAuthorized: false,
      message: active
        ? "Subscription is active. Broker verification and separate REAL-trading authorization are still required."
        : "No active REAL trading subscription. DEMO access remains free."
    });
  } catch (error) {
    console.error("Subscription status error:", error.message);
    return res.status(500).json({ error: "Could not check subscription status." });
  }
}
