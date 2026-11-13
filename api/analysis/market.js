import { createClient } from "@supabase/supabase-js";
import { getDerivCandles } from "../../lib/deriv-candles.js";
import { analyseStrategy } from "../../lib/strategy-engine.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Market analyst is not configured." });
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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const instrument = String(body.instrument || "").trim().toUpperCase();
    const timeframe = String(body.timeframe || "M15").trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,24}$/.test(instrument)) {
      return res.status(400).json({ error: "Choose a supported instrument." });
    }
    const strategy = String(body.strategy || "MULTI_CONFIRMATION_V1");
    if (!["MULTI_CONFIRMATION_V1", "TIGER_FIBONACCI_PSYCHOLOGY_V1", "MANUAL_REVIEW"].includes(strategy)) {
      return res.status(400).json({ error: "Choose a supported strategy." });
    }
    const market = await getDerivCandles(instrument, timeframe);
    const trendMarket = strategy === "TIGER_FIBONACCI_PSYCHOLOGY_V1" && timeframe !== "H1"
      ? await getDerivCandles(instrument, "H1")
      : market;
    const result = analyseStrategy(market.candles, strategy, {
      trendCandles: trendMarket.candles,
      instrument
    });
    return res.status(200).json({
      ok: true,
      instrument: market.instrument,
      providerSymbol: market.providerSymbol,
      timeframe: market.timeframe,
      source: market.source,
      strategy,
      trendTimeframe: strategy === "TIGER_FIBONACCI_PSYCHOLOGY_V1" ? "H1" : timeframe,
      latestCandleAsOf: market.latestCandleAsOf,
      analysedAt: new Date().toISOString(),
      result,
      execution: "NONE",
      message: "Smart strategy analysis only. No order was opened, modified or closed."
    });
  } catch (error) {
    console.error("Market analysis failed:", error.message);
    return res.status(503).json({ error: error.message || "Could not analyse the selected market." });
  }
}
