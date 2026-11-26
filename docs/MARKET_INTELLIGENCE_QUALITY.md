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

The general Deriv candle-history adapter supports M5, M15, H1 and H4. The separate DEMO scalping worker builds completed M1 candles from its timestamped Deriv tick stream; this does not make M1 available through the general candle-history adapter.

A ready analysis is not broker authorization. Account ownership, explicit REAL opt-in, subscription, broker permission, position sizing, protective stops, idempotency, daily loss/drawdown limits and emergency stop remain separate mandatory checks. No return or profit is guaranteed.


## Runtime wiring and current provider coverage

The market analyst endpoint and the DEMO scalping worker now call the shared server-side runtime gate. The current candidate evidence is from Deriv only. No independently verified economic-news, sentiment, institutional order-flow, or external liquidity provider is currently wired into these runtime paths.

Consequently, a single Deriv candidate is not sufficient to produce an approved direction. M1/M5 scalping remains WAIT until the required categories, at least three independent providers, a fresh acceptable spread, a confirmed entry trigger, and verified CLEAR news status are supplied. Missing news status is UNKNOWN, never CLEAR. The worker records the gate reasons in its health state and does not save a candidate signal or open a DEMO paper position when the gate blocks.

The non-secret configuration values MARKET_ANALYST_MAX_SPREAD_BPS and SCALPING_MAX_SPREAD_BPS must be set to positive, reviewed thresholds before their respective spread checks can pass. These settings do not replace provider evidence or the news gate.

Passing this analysis gate still does not authorize broker execution. REAL execution remains subject to the separate platform-wide release switch, account authorization, subscription, broker verification, risk controls, and explicit user approval.
