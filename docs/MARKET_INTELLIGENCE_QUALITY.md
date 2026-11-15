# Market intelligence quality gate

This module is a deterministic, source-audited signal-fusion gate. It consumes evidence supplied by trusted server-side adapters; it does not fetch market data, invent missing inputs, or place orders.

## Evidence requirements

Each item must include a recognized category, BUY/SELL/NEUTRAL direction, source identity, timestamp and confidence between 0 and 100. Stale and future-dated evidence is rejected. Duplicate evidence from the same provider and category is counted once, and provider identity is normalized case-insensitively before independent-source counting.

For M1/M5 sensitive scalping, technical, multi-timeframe, price-action and liquidity confirmation are mandatory. At least four evidence categories and three independent providers are required, alongside fresh quote data, a completed candle, a confirmed entry trigger, acceptable spread, no high-impact-news blackout and minimum risk/reward of 1.5 by default. Missing or conflicting evidence returns WAIT.

Confidence is a quality score, not a probability of profit. Directional agreement is the dominant component; evidence breadth is a bounded modifier. The threshold is now mathematically reachable with the documented minimum four categories, while all other safety gates remain in force.

## Adapter and integration boundary

The module only validates supplied evidence. It does not prove that external news, sentiment, liquidity or order-flow feeds are connected or licensed. Do not claim institutional order flow from retail tick volume. Do not connect this module to automatic execution until every source adapter, instrument mapping, timestamp and risk input is independently verified.

The current Deriv candle adapter supports M5, M15, H1 and H4; it does not currently provide M1 candles. Therefore M1 must not be advertised as available through that adapter until a verified M1 feed is implemented and tested.

A ready analysis is not broker authorization. Account ownership, explicit REAL opt-in, subscription, broker permission, position sizing, protective stops, idempotency, daily loss/drawdown limits and emergency stop remain separate mandatory checks. No return or profit is guaranteed.
