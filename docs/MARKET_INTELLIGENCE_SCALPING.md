# Market intelligence and sensitive scalping design

## What the engine does
`lib/market-intelligence.js` is a deterministic signal-fusion and pre-trade quality gate. It accepts timestamped, source-identified evidence from trusted server-side adapters and combines technical indicators, multi-timeframe direction, price action, liquidity, order flow, sentiment, news, volatility and fundamental context when those feeds are actually connected.

It does not claim to ingest every signal available worldwide. A source is counted only when a licensed/authorized adapter supplies a valid direction, confidence, source identity and timestamp. Missing or stale inputs are visible and can force WAIT. Never manufacture missing sentiment, news, order-flow or institutional-flow data.

## Sensitive scalping behavior
M1/M5 are evaluated as a fast-entry mode, not a low-quality mode. It requires technical, multi-timeframe, price-action and liquidity confirmation; at least four evidence categories and three independent sources; fresh evidence; a closed entry candle; a fresh quote; a verified tradable instrument; an explicit entry trigger; acceptable spread; no high-impact-news blackout; and minimum reward/risk of 1.5 by default. Disagreement or incomplete data returns WAIT. This deliberately prefers fewer high-quality entries over forcing trades.

## Data adapters still required
- Licensed real-time market data and instrument contract specifications for each supported broker/market.
- Economic calendar and verified news feed, with event timestamps and impact classifications.
- Sentiment provider with provenance and coverage metadata.
- Order-flow/liquidity provider where legally available; do not label retail tick volume as institutional order flow.
- Fundamental/macro feeds appropriate to the asset class.
- Multi-timeframe candle service with closed-candle timestamps.
- Broker-specific spread, commission, slippage, margin and minimum-distance checks.

## Execution boundary
The module returns `SIGNAL_READY_FOR_RISK_GATE`, never broker authorization. A separate service must verify account ownership, explicit REAL opt-in, active subscription, broker connection, max risk, daily loss/drawdown limits, open-position exposure, idempotency, broker-native protective stops and emergency stop. No expected return or profit is guaranteed. Test in DEMO and forward-test before considering live deployment.
