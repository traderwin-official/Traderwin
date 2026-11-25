import { createClient } from "@supabase/supabase-js";

const noStore = res => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
};
const validRef = value => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;

export default async function handler(req, res) {
  noStore(res);
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Emergency controls are not configured." });
  }
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ") || !authorization.slice(7).trim()) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const body = req.method === "POST"
      ? (typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}))
      : (req.query || {});
    const accountMode = String(body.accountMode || "").toUpperCase();
    const broker = String(body.broker || "").toUpperCase();
    const accountRef = String(body.accountRef || "").trim();
    const action = String(body.action || "STATUS").toUpperCase();
    if (!["DEMO", "REAL"].includes(accountMode) || !["DERIV", "MT5"].includes(broker) ||
        !validRef(accountRef) || !["STATUS", "STOP_ENTRIES", "CLEAR_STOP"].includes(action)) {
      return res.status(400).json({ error: "Provide a valid account mode, broker, account reference and action." });
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const userId = auth.user.id;

    if (accountMode === "DEMO" && accountRef !== `DEMO:${userId}`) {
      return res.status(403).json({ error: "DEMO controls must use your own server-defined demo account reference." });
    }
    if (accountMode === "REAL") {
      const provider = broker;
      const { data: connection, error: connectionError } = await db
        .from("broker_connections")
        .select("external_account_id,connection_status,verified_at,account_mode")
        .eq("user_id", userId).eq("provider", provider)
        .eq("external_account_id", accountRef).eq("account_mode", "REAL")
        .maybeSingle();
      if (connectionError) return res.status(503).json({ error: "Could not verify the broker account." });
      if (!connection || connection.connection_status !== "CONNECTED" || !connection.verified_at) {
        return res.status(403).json({ error: "REAL emergency controls require a verified broker account connection." });
      }
    }

    const key = { user_id: userId, account_mode: accountMode, broker, broker_account_ref: accountRef };
    if (req.method === "GET" || action === "STATUS") {
      const { data, error } = await db.from("bot_emergency_controls")
        .select("kill_switch_active,reason,changed_at")
        .match(key).maybeSingle();
      if (error) return res.status(503).json({ error: "Could not load emergency status. Apply the emergency-controls migration first." });
      return res.status(200).json({
        ok: true,
        accountMode,
        broker,
        killSwitchActive: data?.kill_switch_active ?? false,
        changedAt: data?.changed_at ?? null,
        reason: data?.reason ?? null,
        note: "This control blocks new entries only. It does not close open positions."
      });
    }

    const active = action === "STOP_ENTRIES";
    const { data, error } = await db.from("bot_emergency_controls").upsert({
      ...key,
      kill_switch_active: active,
      reason: active ? "USER_EMERGENCY_STOP" : null,
      changed_at: new Date().toISOString()
    }, { onConflict: "user_id,account_mode,broker,broker_account_ref" })
      .select("kill_switch_active,reason,changed_at").single();
    if (error || !data) return res.status(503).json({ error: "Could not save emergency control." });
    await db.from("bot_activity").insert({
      user_id: userId,
      event_type: active ? "STOP_REQUESTED" : "CONFIG_SAVED",
      account_mode: accountMode,
      details: { control: "EMERGENCY_ENTRY_KILL_SWITCH", broker, account_ref: accountRef, active }
    });
    return res.status(200).json({
      ok: true,
      killSwitchActive: data.kill_switch_active,
      changedAt: data.changed_at,
      note: active
        ? "New entries are halted. Existing positions remain open and require separately authorized risk management."
        : "The emergency latch is cleared. Bot entries must still pass all live connection, quote, risk and execution checks."
    });
  } catch (error) {
    console.error("Emergency control error:", error?.message || "Unknown error");
    return res.status(500).json({ error: "Emergency control request failed." });
  }
}
