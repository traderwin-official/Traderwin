import { analyseStrategy } from "./strategy-engine.js";
import { calculatePaperPosition, calculatePaperPnl } from "./demo-risk.js";

const GRANULARITY = { M5: 300, M15: 900, H1: 3600, H4: 14400 };
const finite = Number.isFinite;

export function decideDemoAutoAction({ session, settings, quote, market, openTrade, now = Date.now() }) {
  if (!session || !["RUNNING", "PAUSED"].includes(session.status) || session.account_mode !== "DEMO") {
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

  if (openTrade) {
    if (openTrade.status !== "OPEN" || (quote.instrument && openTrade.symbol !== quote.instrument) ||
        !["BUY", "SELL"].includes(openTrade.direction)) {
      return { action: "BLOCK", reason: "OPEN_TRADE_SCOPE_INVALID" };
    }
    const stopHit = openTrade.direction === "BUY"
      ? quote.quote <= Number(openTrade.stop_loss)
      : quote.quote >= Number(openTrade.stop_loss);
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
    const unrealizedPnl = calculatePaperPnl({
      direction: openTrade.direction, entry: Number(openTrade.entry_price),
      exit: quote.quote, units: Number(openTrade.virtual_units)
    });
    return {
      action: stopHit ? "CLOSE" : stage ? "TAKE_PROFIT" : "MARK",
      reason: stopHit ? "STOP_LOSS" : stage || "POSITION_OPEN",
      stage, tradeId: openTrade.id, exitPrice: quote.quote, unrealizedPnl, quote
    };
  }

  const timeframe = String(settings.timeframe || "M15").toUpperCase();
  const granularity = GRANULARITY[timeframe];
  if (!granularity || !market || market.source !== "DERIV" || market.timeframe !== timeframe ||
      !Array.isArray(market.candles) || market.candles.length < 35) {
    return { action: "BLOCK", reason: "MARKET_HISTORY_UNAVAILABLE" };
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
  if (!["MULTI_CONFIRMATION_V1", "TIGER_FIBONACCI_PSYCHOLOGY_V1"].includes(strategy)) {
    return { action: "BLOCK", reason: "STRATEGY_NOT_VALIDATED" };
  }
  const analysis = analyseStrategy(market.candles, strategy, {
    trendCandles: market.trendCandles || market.candles, instrument: settings.instrument
  });
  if (analysis.direction === "WAIT") {
    return { action: "WAIT", reason: "NO_CONFIRMED_SIGNAL", analysis, candleAsOf: market.latestCandleAsOf };
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
    sizing = calculatePaperPosition({ balance: Number(session.current_balance), riskPct, entry, stop });
  } catch {
    return { action: "BLOCK", reason: "POSITION_SIZING_FAILED" };
  }
  return {
    action: "OPEN", reason: "NEW_CONFIRMED_CANDLE_SIGNAL",
    symbol: settings.instrument, direction: analysis.direction, entry, stop, target,
    units: sizing.units, riskAmount: sizing.riskAmount, riskPct, quote,
    candleAsOf: market.latestCandleAsOf, analysis
  };
}
