import { createClient } from "@supabase/supabase-js";
import { calculatePaperPnl } from "../../../lib/demo-risk.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Demo simulator is not configured." });
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const tradeId = String(body.tradeId || "");
    const currentPrice = Number(body.currentPrice);
    if (!/^[0-9a-f-]{36}$/i.test(tradeId) || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return res.status(400).json({ error: "Enter a valid trade ID and current demo price." });
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(header.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }

    return res.status(503).json({ error: "Verified live market-data feed is not connected. DEMO price marking is temporarily disabled until a trusted quote adapter is ready." });

    const { data: trade, error: tradeError } = await db.from("demo_bot_trades")
      .select("id,direction,entry_price,virtual_units,status")
      .eq("id", tradeId)
      .eq("user_id", auth.user.id)
      .eq("status", "OPEN")
      .maybeSingle();
    if (tradeError || !trade) {
      return res.status(404).json({ error: "Open paper trade not found." });
    }

    const unrealizedPnl = calculatePaperPnl({
      direction: trade.direction,
      entry: Number(trade.entry_price),
      exit: currentPrice,
      units: Number(trade.virtual_units)
    });
    const markedAt = new Date().toISOString();
    const { error: updateError } = await db.from("demo_bot_trades")
      .update({ last_mark_price: currentPrice, last_mark_at: markedAt })
      .eq("id", trade.id)
      .eq("user_id", auth.user.id)
      .eq("status", "OPEN");
    if (updateError) {
      return res.status(503).json({ error: "Could not save the demo price mark." });
    }

    return res.status(200).json({
      ok: true,
      closed: false,
      currentUnrealizedPnl: unrealizedPnl,
      markedAt,
      protection: {
        active: false,
        scope: "PORTFOLIO",
        reason: "AWAITING_PORTFOLIO_MONITOR"
      },
      message: "Demo price mark saved. The 20% giveback rule is portfolio-wide, not per trade; it will not be triggered by this individual mark endpoint."
    });
  } catch (error) {
    console.error("Demo mark:", error.message);
    return res.status(500).json({ error: "Could not process the demo price mark." });
  }
}
