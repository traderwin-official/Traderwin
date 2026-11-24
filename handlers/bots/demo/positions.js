import { createClient } from "@supabase/supabase-js";
import { calculatePaperPnl } from "../../../lib/demo-risk.js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";
import { getDerivQuoteToUsd } from "../../../lib/usd-conversion.js";

const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "DEMO positions service is not configured." });
  }
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ") || !authorization.slice(7).trim()) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7).trim());
    if (authError || !auth.user) return res.status(401).json({ error: "Your login session is invalid." });

    const { data: trades, error } = await db.from("demo_paper_trades")
      .select("id,session_id,instrument,side,entry_price,stop_loss,take_profit,remaining_quantity,status,trade_origin,opened_at,realized_pnl_usd")
      .eq("user_id", auth.user.id)
      .eq("status", "OPEN")
      .order("opened_at", { ascending: false })
      .limit(100);
    if (error) {
      console.error("DEMO live positions lookup failed:", error.message);
      return res.status(503).json({ error: "Could not load your open DEMO positions." });
    }

    const symbols = [...new Set((trades || []).map(t => t.instrument).filter(Boolean))];
    const quoteResults = await Promise.all(symbols.map(async symbol => {
      try {
        const quote = await getDerivPublicQuote(symbol);
        if (quote.source !== "DERIV" || normalise(quote.instrument) !== normalise(symbol) || !quote.providerSymbol) {
          throw new Error("Verified quote does not match the open position.");
        }
        const quoteTime = Date.parse(quote.quoteAsOf || "");
        if (!Number.isFinite(quoteTime) || Date.now() - quoteTime > 30000 || quoteTime > Date.now() + 5000) {
          throw new Error("The latest market quote is stale or has an invalid timestamp.");
        }
        const conversion = await getDerivQuoteToUsd(symbol, quote);
        return [symbol, { quote: quote.quote, source: quote.source, asOf: quote.quoteAsOf, providerSymbol: quote.providerSymbol, quoteToUsd: conversion.rate }];
      } catch (error) {
        return [symbol, { error: error?.message || "Live quote unavailable." }];
      }
    }));
    const quotes = new Map(quoteResults);

    const positions = (trades || []).map(trade => {
      const market = quotes.get(trade.instrument);
      let unrealizedPnl = null;
      let quoteStatus = "UNAVAILABLE";
      if (market && !market.error) {
        try {
          unrealizedPnl = calculatePaperPnl({
            direction: trade.side,
            entry: Number(trade.entry_price),
            exit: Number(market.quote),
            units: Number(trade.remaining_quantity),
            quoteToUsd: Number(market.quoteToUsd)
          });
          if (!Number.isFinite(unrealizedPnl)) throw new Error("P/L calculation was invalid.");
          quoteStatus = "LIVE";
        } catch {
          quoteStatus = "UNAVAILABLE";
        }
      }
      return {
        id: trade.id,
        session_id: trade.session_id,
        instrument: trade.instrument,
        side: trade.side,
        entry_price: Number(trade.entry_price),
        current_price: market && !market.error ? Number(market.quote) : null,
        stop_loss: Number(trade.stop_loss),
        take_profit: Number(trade.take_profit),
        remaining_quantity: Number(trade.remaining_quantity),
        trade_origin: trade.trade_origin === "BOT" ? "AUTOMATIC" : "MANUAL",
        opened_at: trade.opened_at,
        realized_pnl_usd: Number(trade.realized_pnl_usd || 0),
        unrealized_pnl_usd: unrealizedPnl === null ? null : Number(unrealizedPnl.toFixed(2)),
        quote_status: quoteStatus,
        quote_error: market?.error || null,
        quote_source: market?.source || null,
        quote_as_of: market?.asOf || null,
        provider_symbol: market?.providerSymbol || null
      };
    });

    const knownFloating = positions.filter(p => Number.isFinite(p.unrealized_pnl_usd));
    const floatingPnl = knownFloating.reduce((sum, p) => sum + p.unrealized_pnl_usd, 0);
    return res.status(200).json({
      mode: "DEMO",
      paperOnly: true,
      source: "DERIV_PUBLIC_MARKET_DATA",
      generatedAt: new Date().toISOString(),
      openCount: positions.length,
      manualCount: positions.filter(p => p.trade_origin === "MANUAL").length,
      automaticCount: positions.filter(p => p.trade_origin === "AUTOMATIC").length,
      floatingPnlUsd: knownFloating.length === positions.length ? Number(floatingPnl.toFixed(2)) : null,
      positions
    });
  } catch (error) {
    console.error("DEMO live positions error:", error?.message || "unknown");
    return res.status(500).json({ error: "Could not load live DEMO positions safely." });
  }
}
