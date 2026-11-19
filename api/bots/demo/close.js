import { createClient } from "@supabase/supabase-js";
import { getDerivPublicQuote } from "../../../lib/deriv-public-quote.js";
import { getDerivQuoteToUsd } from "../../../lib/usd-conversion.js";

const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");

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
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in is required." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const tradeId = String(body.tradeId || "");
    if (!/^[0-9a-f-]{36}$/i.test(tradeId)) {
      return res.status(400).json({ error: "Enter a valid paper trade ID." });
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7).trim());
    if (authError || !auth.user) {
      return res.status(401).json({ error: "Your login session is invalid." });
    }

    const { data: trade, error: tradeError } = await db.from("demo_bot_trades")
      .select("id,user_id,symbol,status")
      .eq("id", tradeId)
      .eq("user_id", auth.user.id)
      .eq("status", "OPEN")
      .maybeSingle();
    if (tradeError || !trade) {
      return res.status(404).json({ error: "Open paper trade not found." });
    }

    let quote;
    try {
      quote = await getDerivPublicQuote(trade.symbol);
    } catch (error) {
      return res.status(503).json({ error: error.message || "Could not obtain a fresh Deriv quote." });
    }
    if (quote.source !== "DERIV" ||
        normalise(quote.instrument) !== normalise(trade.symbol) ||
        typeof quote.providerSymbol !== "string" || !quote.providerSymbol.trim()) {
      return res.status(503).json({ error: "The verified quote does not match this paper trade instrument." });
    }

    let conversion;
    try {
      conversion = await getDerivQuoteToUsd(trade.symbol, quote);
    } catch (error) {
      return res.status(503).json({ error: error.message || "A fresh USD conversion quote is unavailable. The paper trade was not closed." });
    }

    const { data: result, error: closeError } = await db.rpc("close_demo_paper_trade", {
      p_user_id: auth.user.id,
      p_trade_id: trade.id,
      p_instrument: trade.symbol,
      p_exit_price: quote.quote,
      p_quote_to_usd: conversion.rate,
      p_quote_source: quote.source,
      p_quote_as_of: quote.quoteAsOf
    });
    if (closeError) {
      console.error("Atomic paper close failed:", closeError.message);
      return res.status(503).json({ error: "Paper close could not be completed safely. Please retry after the DEMO database update is installed." });
    }
    if (!result?.ok) {
      return res.status(409).json({ error: "Paper trade could not be closed; it may already be closed." });
    }

    return res.status(200).json({
      ok: true,
      trade: {
        id: result.trade_id,
        exit_price: result.exit_price,
        realized_pnl: result.realized_pnl_total,
        realized_pnl_this_stage: result.realized_pnl_this_stage,
        status: "CLOSED"
      },
      riskLocked: result.risk_locked,
      quote: { source: quote.source, asOf: quote.quoteAsOf, instrument: quote.providerSymbol },
      message: "Paper trade closed at a fresh Deriv market quote. Balance and risk limits were updated atomically; no broker order was sent."
    });
  } catch (error) {
    console.error("Paper close:", error.message);
    return res.status(500).json({ error: "Could not close paper trade." });
  }
}
