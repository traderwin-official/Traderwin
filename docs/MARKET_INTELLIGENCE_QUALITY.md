# Market intelligence quality gate

This module is a deterministic, source-audited signal-fusion gate. It consumes evidence supplied by trusted server-side adapters; it does not fetch market data, invent missing inputs, or place orders.

## Evidence contract

Each evidence item must include:
- A recognized category and BUY/SELL/NEUTRAL direction.
- A stable provider identity and timestamp.
- Confidence from 0 to 100.
- `adapterVerified: true`, set only by the trusted server-side adapter after its own provider, schema and freshness checks.
- The exact instrument symbol used by the requested analysis.
- For chart-derived evidence, the exact requested timeframe. Multi-timeframe evidence must include the requested timeframe and at least one higher timeframe.

Evidence for a different instrument/timeframe, unverified adapter evidence, stale evidence and future-dated evidence is rejected. Duplicate evidence from the same provider and category is counted once, and provider identity is normalized case-insensitively before independent-source counting. The attestation field is a server-adapter contract, not cryptographic proof; never accept browser-supplied evidence or a browser-supplied verification flag.

## Signal and risk gates

For M1/M5 sensitive scalping, technical, multi-timeframe, price-action and liquidity confirmation are mandatory. At least four evidence categories and three independent providers are required, alongside a fresh quote, a completed candle, a confirmed entry trigger, acceptable spread, verified clear news status and minimum risk/reward of 1.5 by default. Missing news status is not treated as safe. Missing or conflicting evidence returns WAIT.

Confidence is a quality score, not a probability of profit. Directional agreement is the dominant component; evidence breadth is a bounded modifier.

## Adapter and integration boundary

The module only validates supplied evidence. It does not prove that external news, sentiment, liquidity or order-flow feeds are connected or licensed. Do not claim institutional order flow from retail tick volume. Do not connect this module to automatic execution until every source adapter, instrument mapping, timeframe mapping, timestamp and risk input is independently verified.

The current development Deriv candle adapter supports M5, M15, H1 and H4; M1 is not yet verified through that adapter. Therefore M1 must not be advertised as available through it until a verified M1 feed is implemented and tested.

A ready analysis is not broker authorization. Account ownership, explicit REAL opt-in, subscription, broker permission, position sizing, protective stops, idempotency, daily loss/drawdown limits and emergency stop remain separate mandatory checks. No return or profit is guaranteed.
