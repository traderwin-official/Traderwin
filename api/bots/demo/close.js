import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: "Demo simulator is not configured." });
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const tradeId = String(body.tradeId || "");
    const exitPrice = Number(body.exitPrice);
    if (!/^[0-9a-f-]{36}$/i.test(tradeId) || !Number.isFinite(exitPrice) || exitPrice <= 0) return res.status(400).json({ error: "Enter a valid trade ID and closing price." });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await admin.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });
    const { data: trade, error: lookupError } = await admin.from("demo_bot_trades")
      .select("id,user_id,session_id,direction,entry_price,virtual_units,status")
      .eq("id", tradeId).eq("user_id", auth.user.id).eq("status", "OPEN").maybeSingle();
    if (lookupError || !trade) return res.status(404).json({ error: "Open paper trade not found." });
    const pnl = (trade.direction === "BUY" ? exitPrice - Number(trade.entry_price) : Number(trade.entry_price) - exitPrice) * Number(trade.virtual_units);
    const { data: closedTrade, error: closeError } = await admin.from("demo_bot_trades").update({
      exit_price: exitPrice, realized_pnl: pnl, status: "CLOSED", closed_at: new Date().toISOString()
    }).eq("id", trade.id).eq("user_id", auth.user.id).eq("status", "OPEN")
      .select("id,exit_price,realized_pnl,status,closed_at").maybeSingle();
    if (closeError || !closedTrade) return res.status(409).json({ error: "Could not close this paper trade. It may already be closed." });
    const { data: session } = await admin.from("demo_bot_sessions").select("current_balance").eq("id", trade.session_id).maybeSingle();
    if (session) {
      const newBalance = Number(session.current_balance) + pnl;
      await admin.from("demo_bot_sessions").update({ current_balance: Math.max(0,newBalance), updated_at: new Date().toISOString() }).eq("id", trade.session_id);
    }
    return res.status(200).json({ ok: true, trade: closedTrade, message: "Paper trade closed. Result is simulated only." });
  } catch (error) {
    console.error("Demo paper trade close error:", error.message);
    return res.status(500).json({ error: "Could not close the demo paper trade." });
  }
}
