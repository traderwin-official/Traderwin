import { analyseStrategy, ema } from "./strategy-engine.js";
import { calculatePaperPosition, calculatePaperPnl } from "./demo-risk.js";

const GRANULARITY = { M5: 300, M15: 900, H1: 3600, H4: 14400 };
const finite = Number.isFinite;
const normaliseInstrument = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");
function detectSweepContinuation(candles, atrValue) {
  if (!Array.isArray(candles) || candles.length < 16 || !finite(atrValue) || atrValue <= 0) return null;
  // Look for a stop/liquidity run in either of the two completed candles
  // immediately before the latest displacement candle.
  const reference = candles.slice(-13, -3);
  const sweepBars = candles.slice(-3, -1);
  const trigger = candles.at(-1);
  if (reference.length !== 10 || sweepBars.length !== 2) return null;
  const priorLow = Math.min(...reference.map(c => c.low));
  const priorHigh = Math.max(...reference.map(c => c.high));
  const bullishSweep = sweepBars.some(c => c.low < priorLow && c.close > priorLow);
  const bearishSweep = sweepBars.some(c => c.high > priorHigh && c.close < priorHigh);
  const range = trigger.high - trigger.low;
  const body = Math.abs(trigger.close - trigger.open);
  if (range <= 0 || body < atrValue * 0.55) return null;
  const closeLocation = (trigger.close - trigger.low) / range;
  const bullishFollowThrough = trigger.close > trigger.open &&
    closeLocation >= 0.75 && trigger.close > Math.max(...sweepBars.map(c => c.high));
  const bearishFollowThrough = trigger.close < trigger.open &&
    closeLocation <= 0.25 && trigger.close < Math.min(...sweepBars.map(c => c.low));
  if (bullishSweep && bullishFollowThrough && !bearishSweep) {
    return { direction: "BUY", sweep: "BULLISH", triggerEpoch: trigger.epoch, bodyAtr: body / atrValue };
  }
  if (bearishSweep && bearishFollowThrough && !bullishSweep) {
    return { direction: "SELL", sweep: "BEARISH", triggerEpoch: trigger.epoch, bodyAtr: body / atrValue };
  }
  return null;
}

function validCompletedCandles(candles, granularity, latestCandleAsOf) {
  if (!Array.isArray(candles) || candles.length < 35) return false;
  let previousEpoch = 0;
  for (const candle of candles) {
    if (!candle || !finite(candle.epoch) || candle.epoch <= previousEpoch ||
        ![candle.open, candle.high, candle.low, candle.close].every(finite) ||
        candle.low <= 0 || candle.high < candle.low ||
        candle.open < candle.low || candle.open > candle.high ||
        candle.close < candle.low || candle.close > candle.high) return false;
    previousEpoch = candle.epoch;
  }
  const asOf = Date.parse(latestCandleAsOf);
  const expectedAsOf = (candles.at(-1).epoch + granularity) * 1000;
  return finite(asOf) && Math.abs(asOf - expectedAsOf) <= 1000;
}

export function decideDemoAutoAction({ session, settings, quote, market, openTrade, now = Date.now() }) {
  if (!session || !["RUNNING", "PAUSED", "RISK_LOCKED"].includes(session.status) ||
      session.account_mode !== "DEMO" || (session.status === "RISK_LOCKED" && !openTrade)) {
    return { action: "BLOCK", reason: "SESSION_NOT_RUNNING_DEMO" };
  }
  if (!settings) return { action: "BLOCK", reason: "BOT_SETTINGS_UNAVAILABLE" };
  if (!openTrade && (settings.account_mode !== "DEMO" || String(settings.broker).toUpperCase() !== "DERIV")) {
    return { action: "BLOCK", reason: "UNSUPPORTED_DEMO_BROKER" };
  }
  if (!quote || quote.source !== "DERIV" || !finite(quote.quote) || quote.quote <= 0 ||
      !finite(Date.parse(quote.quoteAsOf)) || now - Date.parse(quote.quoteAsOf) < 0 ||
      now - Date.parse(quote.quoteAsOf) > 30000) {
    return { action: "BLOCK", reason: "QUOTE_NOT_FRESH" };
  }
  if (session.status === "PAUSED" && !openTrade) {
    return { action: "BLOCK", reason: "SESSION_PAUSED_NO_OPEN_POSITION" };
  }
  if (!openTrade && session.lossCooldownUntil) {
    const cooldownUntil = Date.parse(session.lossCooldownUntil);
    if (finite(cooldownUntil) && cooldownUntil > now) {
      return { action: "WAIT", reason: "POST_LOSS_COOLDOWN", cooldownUntil: session.lossCooldownUntil,
        consecutiveLosses: Number(session.consecutiveBotLosses) || 1 };
    }
  }

  if (openTrade) {
    if (openTrade.status !== "OPEN" || !normaliseInstrument(openTrade.symbol) ||
        normaliseInstrument(openTrade.symbol) !== normaliseInstrument(quote.instrument) ||
        typeof quote.providerSymbol !== "string" || !quote.providerSymbol.trim() ||
        !["BUY", "SELL"].includes(openTrade.direction)) {
      return { action: "BLOCK", reason: "OPEN_TRADE_SCOPE_INVALID" };
    }
    const stopLoss = Number(openTrade.stop_loss);
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      return { action: "BLOCK", reason: "STOP_LOSS_UNAVAILABLE", tradeId: openTrade.id };
    }
    const stopHit = openTrade.direction === "BUY"
      ? quote.quote <= stopLoss
      : quote.quote >= stopLoss;
    // A verified stop must remain actionable even if legacy/corrupt TP fields
    // are absent. Never let an optional target plan suppress protective exit.
    if (stopHit) {
      const unrealizedPnl = finite(quote.quoteToUsd) && quote.quoteToUsd > 0 &&
        Number.isFinite(Number(openTrade.entry_price)) &&
        Number.isFinite(Number(openTrade.virtual_units))
        ? calculatePaperPnl({
          direction: openTrade.direction, entry: Number(openTrade.entry_price),
          exit: quote.quote, units: Number(openTrade.virtual_units), quoteToUsd: quote.quoteToUsd
        })
        : null;
      return {
        action: "CLOSE", reason: "STOP_LOSS", stage: null,
        tradeId: openTrade.id, exitPrice: quote.quote, unrealizedPnl, quote
      };
    }
    const tpPricesValid = [openTrade.tp1_price, openTrade.tp2_price, openTrade.tp3_price ?? openTrade.take_profit]
      .every(value => Number.isFinite(Number(value)) && Number(value) > 0);
    if (!tpPricesValid) return { action: "BLOCK", reason: "TP_PLAN_UNAVAILABLE", tradeId: openTrade.id };
    const tpReached = price => openTrade.direction === "BUY"
      ? quote.quote >= Number(price)
      : quote.quote <= Number(price);
    const stage = !openTrade.tp1_done && tpReached(openTrade.tp1_price) ? "TP1"
      : openTrade.tp1_done && !openTrade.tp2_done && tpReached(openTrade.tp2_price) ? "TP2"
      : openTrade.tp2_done && !openTrade.tp3_done && tpReached(openTrade.tp3_price ?? openTrade.take_profit) ? "TP3"
      : null;
    const unrealizedPnl = finite(quote.quoteToUsd) && quote.quoteToUsd > 0
      ? calculatePaperPnl({
        direction: openTrade.direction, entry: Number(openTrade.entry_price),
        exit: quote.quote, units: Number(openTrade.virtual_units), quoteToUsd: quote.quoteToUsd
      })
      : null;
    return {
      action: stage ? "TAKE_PROFIT" : "MARK",
      reason: stage || "POSITION_OPEN",
      stage, tradeId: openTrade.id, exitPrice: quote.quote, unrealizedPnl, quote
    };
  }

  const timeframe = String(settings.timeframe || "M15").toUpperCase();
  const granularity = GRANULARITY[timeframe];
  const selectedInstrument = normaliseInstrument(settings.instrument);
  if (!granularity || !selectedInstrument || !market || market.source !== "DERIV" || market.timeframe !== timeframe ||
      normaliseInstrument(market.instrument) !== selectedInstrument ||
      normaliseInstrument(quote.instrument) !== selectedInstrument ||
      typeof market.providerSymbol !== "string" || !market.providerSymbol.trim() ||
      typeof quote.providerSymbol !== "string" || !quote.providerSymbol.trim() ||
      market.providerSymbol !== quote.providerSymbol ||
      !validCompletedCandles(market.candles, granularity, market.latestCandleAsOf)) {
    return { action: "BLOCK", reason: "MARKET_DATA_SCOPE_INVALID" };
  }
  const candleAsOf = Date.parse(market.latestCandleAsOf);
  if (!finite(candleAsOf) || candleAsOf > now || now - candleAsOf > granularity * 2000) {
    return { action: "BLOCK", reason: "CANDLE_HISTORY_STALE" };
  }
  if (session.worker_last_candle_as_of && Date.parse(session.worker_last_candle_as_of) >= candleAsOf) {
    return { action: "WAIT", reason: "CANDLE_ALREADY_PROCESSED" };
  }

  const strategy = settings.strategy || "MULTI_CONFIRMATION_V1";
  if (strategy === "MANUAL_REVIEW") return { action: "BLOCK", reason: "MANUAL_REVIEW_NO_AUTO" };
  if (!["AUTO_SELECT_V1", "MULTI_CONFIRMATION_V1", "TIGER_FIBONACCI_PSYCHOLOGY_V1"].includes(strategy)) {
    return { action: "BLOCK", reason: "STRATEGY_NOT_VALIDATED" };
  }
  let analysis = analyseStrategy(market.candles, strategy, {
    trendCandles: market.trendCandles || market.candles, trendTimeframe: market.trendTimeframe || "H1", instrument: settings.instrument
  });
  // A sweep-and-displacement continuation is an alternative entry setup: it
  // does not require a consolidation/retest, but it must reclaim liquidity
  // and then close with strong directional follow-through.
  const continuation = detectSweepContinuation(market.candles, Number(analysis.indicators?.atr14));
  if (continuation && (analysis.direction === "WAIT" || analysis.direction === continuation.direction)) {
    analysis = { ...analysis, direction: continuation.direction,
      indicators: { ...analysis.indicators, sweepContinuation: continuation },
      explanation: "Liquidity sweep reclaimed and followed by a strong directional displacement candle; continuation entry does not require consolidation." };
  }
  if (analysis.direction === "WAIT") {
    return { action: "WAIT", reason: "NO_CONFIRMED_SIGNAL", analysis, candleAsOf: market.latestCandleAsOf };
  }
  // Require an independent higher-timeframe EMA trend to agree with the entry.
  // H4 is the highest supported timeframe, so it cannot claim independent HTF confirmation.
  const trendCandles = Array.isArray(market.trendCandles) ? market.trendCandles : [];
  const trendTimeframe = String(market.trendTimeframe || "").toUpperCase();
  if (trendTimeframe && trendTimeframe !== "H4") {
    const trendGranularity = GRANULARITY[trendTimeframe];
    const trendAsOf = Date.parse(market.trendCandleAsOf);
    if (!trendGranularity || !validCompletedCandles(trendCandles, trendGranularity, market.trendCandleAsOf) ||
        !finite(trendAsOf) || trendAsOf > now || now - trendAsOf > trendGranularity * 2000) {
      return { action: "BLOCK", reason: "HIGHER_TIMEFRAME_DATA_UNAVAILABLE_OR_STALE", analysis };
    }
    const trendCloses = trendCandles.map(c => c.close);
    const trendFast = ema(trendCloses, 9), trendSlow = ema(trendCloses, 21);
    const trendDirection = trendFast > trendSlow ? "BUY" : trendFast < trendSlow ? "SELL" : "WAIT";
    if (trendDirection !== analysis.direction) {
      return { action: "WAIT", reason: "HIGHER_TIMEFRAME_TREND_MISMATCH",
        analysis, higherTimeframe: trendTimeframe, higherTimeframeDirection: trendDirection };
    }
  }
  // Do not chase a move that has already stretched too far from its completed signal candle.
  const signalClose = Number(market.candles.at(-1)?.close);
  const atrValue = Number(analysis.indicators?.atr14);
  if (!finite(signalClose) || !finite(atrValue) || atrValue <= 0 ||
      (analysis.direction === "BUY" && quote.quote - signalClose > atrValue * 0.75) ||
      (analysis.direction === "SELL" && signalClose - quote.quote > atrValue * 0.75)) {
    return { action: "WAIT", reason: "ENTRY_TOO_EXTENDED_FROM_SIGNAL_CANDLE", analysis };
  }
  if (!finite(quote.quoteToUsd) || quote.quoteToUsd <= 0) {
    return { action: "BLOCK", reason: "USD_CONVERSION_UNAVAILABLE" };
  }
  const entry = quote.quote;
  const stopDistance = analysis.indicators.stopLoss
    ? Math.abs(entry - analysis.indicators.stopLoss)
    : analysis.indicators.atr14 * 1.5;
  // TP1/TP2/TP3 are fixed at 1R/2R/3R from the initial stop distance.
  // The strategy's former single take-profit no longer overrides staged TP3.
  const targetDistance = stopDistance * 3;
  if (!finite(stopDistance) || stopDistance <= 0 || !finite(targetDistance) || targetDistance <= 0) {
    return { action: "BLOCK", reason: "INVALID_ATR_RISK_LEVELS" };
  }
  const stop = analysis.direction === "BUY" ? entry - stopDistance : entry + stopDistance;
  const target = analysis.direction === "BUY" ? entry + targetDistance : entry - targetDistance;
  const riskPct = Number(session.max_risk_per_trade_pct);
  let sizing;
  try {
    sizing = calculatePaperPosition({ balance: Number(session.current_balance), riskPct, entry, stop, quoteToUsd: quote.quoteToUsd });
  } catch {
    return { action: "BLOCK", reason: "POSITION_SIZING_FAILED" };
  }
  return {
    action: "OPEN", reason: continuation ? "LIQUIDITY_SWEEP_CONTINUATION" : "NEW_CONFIRMED_CANDLE_SIGNAL",
    symbol: settings.instrument, direction: analysis.direction, entry, stop, target,
    units: sizing.units, riskAmount: sizing.riskAmount, riskPct, quote,
    candleAsOf: market.latestCandleAsOf, analysis
  };
}
