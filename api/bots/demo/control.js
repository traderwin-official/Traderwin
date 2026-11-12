import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Demo bot service is not configured." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || "").toUpperCase();
    if (!["START","STOP"].includes(action)) return res.status(400).json({ error: "Choose START or STOP." });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const userId = auth.user.id;

    if (action === "START") {
      const { data: profile, error: profileError } = await admin.from("trader_profiles")
        .select("account_mode,max_risk_per_trade_pct,max_daily_loss_pct")
        .eq("user_id", userId).maybeSingle();
      if (profileError || !profile) return res.status(409).json({ error: "Complete your trading account setup first." });
      if (profile.account_mode !== "DEMO") return res.status(403).json({ error: "Demo paper trading can only start while DEMO mode is selected. REAL mode is not supported by this endpoint." });

      const { data: settings, error: settingsError } = await admin.from("bot_settings")
        .select("id,broker,instrument,account_mode,max_risk_per_trade_pct")
        .eq("user_id", userId).maybeSingle();
      if (settingsError || !settings) return res.status(409).json({ error: "Save your bot preferences before starting the demo simulator." });
      if (settings.account_mode !== "DEMO") return res.status(403).json({ error: "Your bot settings are not in DEMO mode." });

      const risk = Math.min(Number(profile.max_risk_per_trade_pct), Number(settings.max_risk_per_trade_pct));
      const { data: active, error: activeError } = await admin.from("demo_bot_sessions")
        .select("id,status,current_balance,virtual_currency,started_at")
        .eq("user_id", userId).eq("status", "RUNNING").maybeSingle();
      if (activeError) return res.status(503).json({ error: "Could not check existing demo session." });
      if (active) return res.status(200).json({ ok: true, session: active, message: "Your demo session is already running." });

      const { data: session, error: startError } = await admin.from("demo_bot_sessions").insert({
        user_id: userId, bot_setting_id: settings.id, account_mode: "DEMO",
        status: "RUNNING", starting_balance: 10000, current_balance: 10000,
        max_risk_per_trade_pct: risk, max_daily_loss_pct: Number(profile.max_daily_loss_pct)
      }).select("id,status,current_balance,virtual_currency,started_at").single();
      if (startError || !session) {
        console.error("Demo session start failed:", startError?.message);
        return res.status(409).json({ error: "Could not start the demo session. Check whether another session is already running." });
      }
      await admin.from("bot_activity").insert({
        user_id: userId, bot_setting_id: settings.id, event_type: "START_REQUESTED",
        account_mode: "DEMO", details: { session_id: session.id, instrument: settings.instrument, broker_label: settings.broker, simulator: "PAPER_ONLY" }
      });
      return res.status(200).json({ ok: true, session, message: "Demo paper-trading session started. No broker orders are sent." });
    }

    const { data: session, error: lookupError } = await admin.from("demo_bot_sessions")
      .select("id,bot_setting_id,status").eq("user_id", userId).eq("status", "RUNNING").maybeSingle();
    if (lookupError) return res.status(503).json({ error: "Could not load the active demo session." });
    if (!session) return res.status(200).json({ ok: true, session: null, message: "No demo session is currently running." });
    const { error: stopError } = await admin.from("demo_bot_sessions").update({
      status: "STOPPED", stopped_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", session.id).eq("user_id", userId).eq("status", "RUNNING");
    if (stopError) return res.status(503).json({ error: "Could not stop the demo session." });
    await admin.from("bot_activity").insert({
      user_id: userId, bot_setting_id: session.bot_setting_id, event_type: "STOP_REQUESTED",
      account_mode: "DEMO", details: { session_id: session.id }
    });
    return res.status(200).json({ ok: true, session: { id: session.id, status: "STOPPED" }, message: "Demo paper-trading session stopped." });
  } catch (error) {
    console.error("Demo bot control error:", error.message);
    return res.status(500).json({ error: "Demo bot service encountered an error." });
  }
}
