import { createClient } from "@supabase/supabase-js";

const SYMBOL = /^[A-Za-z0-9_]{2,30}$/;
const PROVIDERS = new Set(["DERIV", "MT5"]);
const cleanText = (value, max = 500) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function parseBody(body) {
  if (typeof body === "string") return JSON.parse(body);
  return body && typeof body === "object" ? body : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Instrument administration is not configured." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Administrator sign-in is required." });
  }

  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Login session is invalid or expired." });
    }

    const { data: role, error: roleError } = await db
      .from("traderwin_admin_roles")
      .select("role")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (roleError) {
      console.error("Instrument admin role lookup failed:", { code: roleError.code || null });
      return res.status(503).json({ error: "Could not verify administrator permissions." });
    }
    if (role?.role !== "ADMIN") {
      return res.status(403).json({ error: "Only platform administrators can manage approved instruments." });
    }

    if (req.method === "GET") {
      if (req.query?.audit === "1") {
        const { data, error } = await db
          .from("trading_instrument_approval_audit")
          .select("id,approval_id,broker,instrument,operation,actor_user_id,actor_role,occurred_at,old_record,new_record")
          .order("occurred_at", { ascending: false })
          .limit(100);
        if (error) throw new Error("AUDIT_LOOKUP_FAILED");
        return res.status(200).json({ audit: data || [] });
      }
      const { data, error } = await db
        .from("trading_instrument_approvals")
        .select("id,broker,instrument,provider,provider_symbol,status,is_active,approval_note,approved_by,approved_at,updated_by,updated_at")
        .order("broker", { ascending: true })
        .order("instrument", { ascending: true });
      if (error) throw new Error("REGISTRY_LOOKUP_FAILED");
      return res.status(200).json({ instruments: data || [] });
    }

    let body;
    try { body = parseBody(req.body); }
    catch { return res.status(400).json({ error: "Request body must be valid JSON." }); }
    const action = cleanText(body.action, 20).toLowerCase();
    const broker = cleanText(body.broker, 10).toUpperCase();
    const instrument = cleanText(body.instrument, 30).toUpperCase();
    const provider = cleanText(body.provider, 10).toUpperCase();
    const providerSymbol = cleanText(body.providerSymbol, 40);
    const reason = cleanText(body.reason, 500);

    if (!["register", "approve", "disable"].includes(action) ||
        !PROVIDERS.has(broker) || provider !== broker ||
        !SYMBOL.test(instrument) || !/^[A-Za-z0-9_]{2,40}$/.test(providerSymbol)) {
      return res.status(400).json({ error: "Provide a valid action, broker, instrument and exact provider-symbol mapping." });
    }
    if (reason.length < 8) {
      return res.status(400).json({ error: "Provide an audit reason of at least 8 characters." });
    }

    const actor = auth.user.id;
    const now = new Date().toISOString();
    let query;
    if (action === "register") {
      query = db.from("trading_instrument_approvals").insert({
        broker, instrument, provider, provider_symbol: providerSymbol,
        status: "PENDING", is_active: false, approval_note: reason,
        approved_by: null, approved_at: null, updated_by: actor, updated_at: now
      });
    } else if (action === "approve") {
      query = db.from("trading_instrument_approvals").update({
        status: "APPROVED", is_active: true, approved_by: actor,
        approved_at: now, approval_note: reason, updated_by: actor, updated_at: now
      }).eq("broker", broker).eq("instrument", instrument).eq("provider", provider)
        .eq("provider_symbol", providerSymbol);
    } else {
      query = db.from("trading_instrument_approvals").update({
        status: "DISABLED", is_active: false, approval_note: reason,
        updated_by: actor, updated_at: now
      }).eq("broker", broker).eq("instrument", instrument).eq("provider", provider)
        .eq("provider_symbol", providerSymbol);
    }

    const { data, error } = await query
      .select("id,broker,instrument,provider,provider_symbol,status,is_active,approval_note,approved_by,approved_at,updated_by,updated_at")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "An instrument or provider symbol is already registered for this broker." });
      console.error("Instrument approval mutation failed:", { code: error.code || null });
      return res.status(503).json({ error: "Instrument registry change could not be saved." });
    }
    if (!data) return res.status(404).json({ error: "The matching instrument registration was not found." });
    return res.status(action === "register" ? 201 : 200).json({
      ok: true, instrument: data,
      message: action === "register" ? "Instrument registered as pending. It is not enabled for trading." :
        action === "approve" ? "Instrument approved. All other account, quote, risk and execution gates still apply." :
          "Instrument disabled. New entries must be blocked by the server."
    });
  } catch (error) {
    console.error("Instrument administration error:", { message: error?.message || "unknown" });
    return res.status(503).json({ error: "Instrument administration request failed safely." });
  }
}
