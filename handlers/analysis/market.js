import { createClient } from "@supabase/supabase-js";
import { getDerivCandles } from "../../lib/deriv-candles.js";
import { analyseStrategy, analyseCandles } from "../../lib/strategy-engine.js";
import { buildAnalystTradePlan } from "../../lib/analyst-trade-plan.js";
import { getDerivPublicQuote } from "../../lib/deriv-public-quote.js";
import { loadApprovedInstrument } from "../../lib/deriv/load-approved-instrument.js";
import { evaluateMarketCandidate } from "../../lib/market-intelligence-gate.js";
import { getGdeltNewsContext } from "../../lib/gdelt-news-context.js";
import { getGdeltNewsRiskStatus } from "../../lib/gdelt-news-risk.js";
import { getBiQuoteCalendarRiskStatus } from "../../lib/biquote-calendar-risk.js";

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
    const accountMode = String(body.accountMode || "DEMO").trim().toUpperCase();
    if (!["DEMO", "REAL"].includes(accountMode)) {
      return res.status(400).json({ error: "Choose DEMO or REAL analysis mode." });
    }
    const strategy = String(body.strategy || "MULTI_CONFIRMATION_V1");
    if (!["AUTO_SELECT_V1", "MULTI_CONFIRMATION_V1", "TIGER_FIBONACCI_PSYCHOLOGY_V1", "MANUAL_REVIEW"].includes(strategy)) {
      return res.status(400).json({ error: "Choose a supported strategy." });
    }
    const higherTimeframe = ({ M5: "M15", M15: "H1", H1: "H4" })[timeframe] || null;
    const marketPromise = getDerivCandles(instrument, timeframe, { timeoutMs: 6000 });
    const trendPromise = higherTimeframe
      ? getDerivCandles(instrument, higherTimeframe, { timeoutMs: 6000 })
      : Promise.resolve(null);
    const quotePromise = getDerivPublicQuote(instrument, { timeoutMs: 4000 }).catch(() => null);
    const newsPromise = getGdeltNewsContext(instrument);
    const newsRiskPromise = getGdeltNewsRiskStatus();
    const calendarRiskPromise = getBiQuoteCalendarRiskStatus({ instrument });
    const [market, trendMarket, quote, newsContext, newsRisk, calendarRisk] = await Promise.all([
      marketPromise, trendPromise, quotePromise, newsPromise, newsRiskPromise, calendarRiskPromise
    ]);
    const combinedNewsStatus = newsRisk.status === "BLACKOUT" || calendarRisk.status === "BLACKOUT"
      ? "BLACKOUT" : "UNKNOWN";
    const candidate = analyseStrategy(market.candles, strategy, {
      trendCandles: trendMarket?.candles || market.candles,
      trendTimeframe: higherTimeframe || timeframe,
      instrument
    });
    const higherResult = trendMarket ? analyseCandles(trendMarket.candles) : null;
    const mtfAgrees = Boolean(higherResult &&
      ["BUY", "SELL"].includes(candidate.direction) &&
      higherResult.direction === candidate.direction);
    const mtfStatus = !higherResult ? "HIGHER_TIMEFRAME_UNAVAILABLE"
      : mtfAgrees ? "ALIGNED"
      : ["BUY", "SELL"].includes(candidate.direction) && ["BUY", "SELL"].includes(higherResult.direction)
        ? "CONFLICT" : "NO_HIGHER_TIMEFRAME_SIGNAL";
    const result = {
      ...candidate,
      direction: mtfAgrees ? candidate.direction : "WAIT",
      confidence: mtfAgrees ? Math.min(candidate.confidence, higherResult.confidence) : 0,
      multiTimeframe: {
        signalTimeframe: timeframe,
        higherTimeframe: higherTimeframe || null,
        status: mtfStatus,
        signalDirection: candidate.direction,
        higherTimeframeDirection: higherResult?.direction || "UNAVAILABLE",
        higherTimeframeConfidence: higherResult?.confidence ?? null
      },
      explanation: mtfAgrees
        ? candidate.explanation + ` Higher-timeframe ${higherTimeframe} confirmation agrees.`
        : "WAIT: selected-timeframe and higher-timeframe evidence are not aligned or the higher timeframe is unavailable."
    };
    const approval = await loadApprovedInstrument(admin, {
      broker: "DERIV", instrument, providerSymbol: market.providerSymbol
    });
    const quoteStamp = Date.parse(quote?.quoteAsOf || "");
    const quoteFresh = Boolean(
      quote && quote.source === "DERIV" && quote.providerSymbol === market.providerSymbol &&
      Number.isFinite(quoteStamp) && Date.now() - quoteStamp >= 0 && Date.now() - quoteStamp <= 30000
    );
    const bid = Number(quote?.bid), ask = Number(quote?.ask), mid = (bid + ask) / 2;
    const spreadBps = quoteFresh && Number.isFinite(bid) && Number.isFinite(ask) &&
      bid > 0 && ask >= bid && Number.isFinite(mid) && mid > 0
      ? ((ask - bid) / mid) * 10000
      : null;
    const configuredMaxSpreadBps = Number(process.env.MARKET_ANALYST_MAX_SPREAD_BPS);
    const tradePlan = buildAnalystTradePlan({
      direction: mtfAgrees ? candidate.direction : "WAIT",
      quote,
      atr: candidate.indicators?.atr14,
      instrument,
      timeframe
    });
    const marketIntelligence = evaluateMarketCandidate({
      instrument: market.instrument,
      timeframe: market.timeframe,
      direction: result.direction,
      confidence: result.confidence,
      source: market.source,
      asOf: market.latestCandleAsOf,
      market: {
        tradable: approval.approved === true,
        quoteFresh,
        candleClosed: true
      },
      risk: {
        spreadBps,
        maxSpreadBps: Number.isFinite(configuredMaxSpreadBps) && configuredMaxSpreadBps > 0
          ? configuredMaxSpreadBps : null,
        riskReward: tradePlan.status === "INDICATIVE_ONLY" ? tradePlan.riskReward1 : null,
        minimumRiskReward: 1.5,
        entryTriggerConfirmed: mtfAgrees && ["BUY", "SELL"].includes(String(candidate.direction || "").toUpperCase()),
        newsStatus: combinedNewsStatus,
        highImpactNewsWindow: combinedNewsStatus === "BLACKOUT"
      },
      maxAgeMs: Math.max(120000, Number(market.granularity || 0) * 2000)
    });
    const gatedResult = {
      ...result,
      tradePlan,
      direction: marketIntelligence.direction,
      candidateDirection: result.direction,
      candidateConfidence: result.confidence,
      confidence: marketIntelligence.confidence,
      marketIntelligence
    };
    return res.status(200).json({
      ok: true,
      instrument: market.instrument,
      providerSymbol: market.providerSymbol,
      timeframe: market.timeframe,
      source: market.source,
      strategy,
      accountMode,
      trendTimeframe: higherTimeframe,
      latestCandleAsOf: market.latestCandleAsOf,
      analysedAt: new Date().toISOString(),
      result: gatedResult,
      candidate: result,
      marketIntelligence,
      newsContext,
      newsRisk,
      calendarRisk,
      marketData: {
        quoteStatus: quoteFresh ? "FRESH" : "UNAVAILABLE_OR_UNVERIFIED",
        quoteAsOf: quote?.quoteAsOf || null,
        approvalStatus: approval.status || "BLOCKED",
        spreadBps,
        multiTimeframeStatus: mtfStatus,
        higherTimeframeDirection: higherResult?.direction || null,
        tradePlanStatus: tradePlan.status
      },
      execution: "NONE",
      executionAuthorized: false,
      message: marketIntelligence.direction === "WAIT"
        ? "WAIT: verified independent evidence, news status or spread approval is incomplete. No order was opened, modified or closed."
        : "Analysis passed the market-intelligence quality gate but still requires separate risk and broker authorization. No order was opened, modified or closed."
    });
  } catch (error) {
    console.error("Market analysis failed:", error.message);
    return res.status(503).json({ error: error.message || "Could not analyse the selected market." });
  }
}
