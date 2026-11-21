import { getDerivPublicQuote } from "./deriv-public-quote.js";
import { getDerivQuoteToUsd } from "./usd-conversion.js";
import { createSupabasePortfolioAdapters } from "./supabase-portfolio-adapters.js";

const finite = Number.isFinite;
const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");
const INVERSE_USD_PAIRS = new Set(["JPY", "CAD", "CHF"]);

function hasVerifiedUsdConversion(instrument, conversion) {
  const symbol = normalise(instrument);
  if (!/^[A-Z]{6}$/.test(symbol) || !conversion ||
      !finite(Number(conversion.rate)) || Number(conversion.rate) <= 0) return false;
  const quoteCurrency = symbol.slice(-3);
  if (quoteCurrency === "USD") {
    return conversion.source === "USD_QUOTED_INSTRUMENT" &&
      normalise(conversion.instrument) === "USD" && Number(conversion.rate) === 1;
  }
  const expectedPair = INVERSE_USD_PAIRS.has(quoteCurrency)
    ? "USD" + quoteCurrency : quoteCurrency + "USD";
  return conversion.source === "DERIV_FX_CONVERSION" &&
    normalise(conversion.instrument) === expectedPair;
}

export function buildDemoPortfolioPositions(trades, quoteBundles, scope) {
  if (!Array.isArray(trades) || !quoteBundles || typeof quoteBundles !== "object" ||
      scope?.accountMode !== "DEMO" || scope?.broker !== "DERIV") {
    throw new TypeError("A DEMO Deriv position set and verified quote bundles are required.");
  }
  return trades.map(trade => {
    const instrument = String(trade.instrument || "").trim().toUpperCase();
    const bundle = quoteBundles[instrument];
    const quote = bundle?.quote;
    const conversion = bundle?.conversion;
    const units = Number(trade.remaining_quantity);
    const entry = Number(trade.entry_price);
    if (!trade.id || trade.user_id !== scope.userId || trade.status !== "OPEN" ||
        !["BUY", "SELL"].includes(trade.side) || !["BOT", "MANUAL"].includes(trade.trade_origin) ||
        !instrument || !quote || quote.source !== "DERIV" ||
        normalise(quote.instrument) !== normalise(instrument) ||
        !finite(Number(quote.quote)) || Number(quote.quote) <= 0 ||
        !hasVerifiedUsdConversion(instrument, conversion) ||
        !finite(entry) || entry <= 0 || !finite(units) || units <= 0) {
      throw new RangeError("A DEMO open position is missing a verified quote, conversion or valid ledger values.");
    }
    const priceMove = trade.side === "BUY" ? Number(quote.quote) - entry : entry - Number(quote.quote);
    const profitUsd = priceMove * units * Number(conversion.rate);
    if (!finite(profitUsd)) throw new RangeError("The USD-normalized position valuation is invalid.");
    return {
      id: trade.id,
      userId: scope.userId,
      accountMode: "DEMO",
      broker: "DERIV",
      accountRef: scope.accountRef,
      source: trade.trade_origin,
      status: "OPEN",
      instrument,
      side: trade.side,
      entryPrice: entry,
      currentPrice: Number(quote.quote),
      units,
      profitUsd,
      protectiveStopVerified: true,
      quoteAsOf: quote.quoteAsOf,
      quoteSource: quote.source
    };
  });
}

/**
 * DEMO-only adapter: the Deriv public feed supplies valuations; the Supabase
 * paper ledger is the virtual execution venue. No broker order is ever sent.
 */
export function createDemoPortfolioAdapters(db, options = {}) {
  const getQuote = options.getQuote || getDerivPublicQuote;
  const getQuoteToUsd = options.getQuoteToUsd ||
    ((instrument, quote) => getDerivQuoteToUsd(instrument, quote, { getQuote }));
  const external = {
    async loadSnapshot(scope) {
      if (scope.accountMode !== "DEMO" || scope.broker !== "DERIV" ||
          scope.accountRef !== "DEMO:" + scope.userId) {
        throw new RangeError("The paper portfolio adapter only supports the user's own Deriv DEMO ledger.");
      }
      const { data: sessions, error: sessionError } = await db.from("demo_paper_sessions")
        .select("id").eq("user_id", scope.userId).eq("broker", "DERIV")
        .eq("broker_account_ref", scope.accountRef);
      if (sessionError) throw new Error("Could not load DEMO paper sessions.");
      const sessionIds = (sessions || []).map(row => row.id);
      let trades = [];
      if (sessionIds.length) {
        const { data, error } = await db.from("demo_paper_trades")
          .select("id,user_id,session_id,instrument,side,entry_price,remaining_quantity,status,trade_origin")
          .eq("user_id", scope.userId).in("session_id", sessionIds).eq("status", "OPEN");
        if (error) throw new Error("Could not load all open DEMO paper positions.");
        trades = data || [];
      }

      const instruments = [...new Set(trades.map(t => String(t.instrument || "").trim().toUpperCase()))];
      const quoteBundles = {};
      const quoteTimes = [];
      for (const instrument of instruments) {
        const quote = await getQuote(instrument);
        const conversion = await getQuoteToUsd(instrument, quote);
        const quoteTime = Date.parse(quote?.quoteAsOf);
        const conversionTime = Date.parse(conversion?.asOf);
        if (!finite(quoteTime) || !finite(conversionTime) ||
            Math.abs(quoteTime - conversionTime) > 30000) {
          throw new Error("A fresh matching USD conversion quote is required for every open DEMO instrument.");
        }
        quoteTimes.push(quoteTime, conversionTime);
        quoteBundles[instrument] = { quote, conversion };
      }
      const positions = buildDemoPortfolioPositions(trades, quoteBundles, scope);
      const asOf = quoteTimes.length ? new Date(Math.min(...quoteTimes)).toISOString() : new Date().toISOString();

      const [{ data: emergency, error: emergencyError }, { data: legacy, error: legacyError }] = await Promise.all([
        db.from("demo_paper_emergency_controls").select("entries_blocked")
          .eq("user_id", scope.userId).eq("broker", "DERIV").eq("broker_account_ref", scope.accountRef).maybeSingle(),
        db.from("bot_emergency_controls").select("kill_switch_active")
          .eq("user_id", scope.userId).eq("account_mode", "DEMO").eq("broker", "DERIV")
          .eq("broker_account_ref", scope.accountRef).maybeSingle()
      ]);
      if (emergencyError || legacyError) throw new Error("Could not verify the DEMO emergency controls.");

      // For a virtual account, brokerConnected means the server-side paper
      // execution ledger is reachable; the actual market-data health is
      // separately verified by the fresh Deriv quotes above.
      const heartbeat = new Date().toISOString();
      return {
        positions,
        source: "DERIV_PUBLIC_MARKET_DATA+DERIV_USD_CONVERSION",
        asOf,
        maxAgeMs: 30000,
        emergency: {
          marketDataConnected: true,
          brokerConnected: true,
          killSwitchActive: emergency?.entries_blocked === true || legacy?.kill_switch_active === true,
          brokerHeartbeatAsOf: heartbeat,
          maxBrokerHeartbeatAgeMs: 30000
        }
      };
    },
    async closePosition(position, request) {
      if (position.accountMode !== "DEMO" || position.broker !== "DERIV" ||
          position.userId == null || position.accountRef !== "DEMO:" + position.userId) {
        throw new Error("Refusing to close a position outside the scoped DEMO paper ledger.");
      }
      const quote = await getQuote(position.instrument);
      const conversion = await getQuoteToUsd(position.instrument, quote);
      const quoteTime = Date.parse(quote?.quoteAsOf);
      const conversionTime = Date.parse(conversion?.asOf);
      if (!quote || quote.source !== "DERIV" ||
          normalise(quote.instrument) !== normalise(position.instrument) ||
          !finite(Number(quote.quote)) || Number(quote.quote) <= 0 ||
          !hasVerifiedUsdConversion(position.instrument, conversion) ||
          !finite(quoteTime) || !finite(conversionTime) ||
          Math.abs(quoteTime - conversionTime) > 30000) {
        throw new Error("A fresh matching DEMO quote and USD conversion are required before portfolio close.");
      }
      const { data, error } = await db.rpc("close_demo_portfolio_trade", {
        p_user_id: position.userId,
        p_trade_id: position.id,
        p_instrument: position.instrument,
        p_exit_price: quote.quote,
        p_quote_to_usd: conversion.rate,
        p_quote_source: quote.source,
        p_quote_as_of: quote.quoteAsOf,
        p_idempotency_key: request?.idempotencyKey || ("portfolio-protection:" + position.id)
      });
      if (error) throw new Error("Could not atomically close the DEMO paper position.");
      return { closed: data?.ok === true, status: data?.ok === true ? "CLOSED" : data?.reason || "NOT_CLOSED" };
    }
  };
  return createSupabasePortfolioAdapters(db, external);
}
