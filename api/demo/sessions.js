import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
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

    const userId = userData.user.id;
    const { data: sessions, error: sessionsError } = await supabase
      .from("demo_bot_sessions")
      .select("id, broker, broker_account_ref, instrument, strategy, status, risk_per_trade_pct, max_daily_loss_pct, started_at, stopped_at, created_at, updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (sessionsError) {
      console.error("DEMO sessions lookup failed:", { code: sessionsError.code || null });
      return res.status(500).json({ error: "Could not load DEMO practice sessions." });
    }

    const sessionIds = (sessions || []).map((session) => session.id);
    let trades = [];
    if (sessionIds.length > 0) {
      const { data: tradeData, error: tradesError } = await supabase
        .from("demo_bot_trades")
        .select("id, session_id, instrument, side, quantity, entry_price, exit_price, stop_loss, take_profit, pnl, status, opened_at, closed_at, created_at")
        .eq("user_id", userId)
        .in("session_id", sessionIds)
        .order("created_at", { ascending: false })
        .limit(200);

      if (tradesError) {
        console.error("DEMO trades lookup failed:", { code: tradesError.code || null });
        return res.status(500).json({ error: "Could not load DEMO trade history." });
      }
      trades = tradeData || [];
    }

    return res.status(200).json({
      mode: "DEMO",
      paper_only: true,
      automated_execution_enabled: false,
      message: "This endpoint provides session and trade history only. It does not start a bot or place broker orders.",
      sessions: sessions || [],
      trades
    });
  } catch (error) {
    console.error("DEMO session history endpoint error:", { name: error?.name || null });
    return res.status(500).json({ error: "Could not load DEMO practice history." });
  }
}
