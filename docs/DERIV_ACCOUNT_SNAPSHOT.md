# Deriv authenticated account snapshot

**Status:** read-only endpoint and strict normalizers added; not wired into bot entry, sizing, margin or portfolio-risk decisions.

## Flow

1. Authenticate the caller with Supabase and load only that user's encrypted Deriv connection.
2. Require a fresh OAuth token, the user's explicitly selected active DEMO account, and matching server-stored verified account metadata.
3. Decrypt the access token server-side. Recheck the selected account against Deriv's authenticated account list.
4. Request a short-lived OTP for that exact account, and accept only Deriv's documented `wss://api.derivws.com/trading/v1/options/ws/demo` URL.
5. Request `balance` and `portfolio` on that authenticated account-scoped WebSocket session, then request a fresh `proposal_open_contract` valuation for every open contract.
6. Validate account identity, numeric balance, currency, open-contract fields, duplicate IDs and snapshot freshness. Return only sanitized account data with no-store caching.

The endpoint never connects to the REAL WebSocket, sends buy/sell/proposal messages, changes account selection, stores balance data, or authorizes execution. The OAuth token and OTP are never returned to the browser or logged.

## Important boundaries

- Deriv documents `balance` as an authenticated account endpoint and `portfolio` as the list of open positions for the authenticated account. The OTP endpoint returns a ready-to-use account-scoped WebSocket URL and the OTP is single-use and short-lived.
- This account snapshot is useful for account monitoring. It is not a complete margin model or a verified FX/CFD contract specification.
- The Options portfolio may contain contract values for options positions. Do not reinterpret an options stake or payout as MT5 lots, CFD notional, margin, or stop-loss risk.
- No DEMO entry route currently consumes this snapshot. No REAL route consumes it. A separate, broker-specific contract and risk adapter plus end-to-end sandbox validation is still required.

## Open options exposure

The endpoint also returns a conservative read-only `open_stake_at_risk` value: the sum of provider-reported `buy_price` values for all open Deriv Options contracts, with a same-currency check. It returns `open_unrealized_profit` as the sum of fresh provider-reported `profit` values from each contract's authenticated `proposal_open_contract` response. This is an options premium/stake exposure summary, not a margin estimate, CFD/FX notional, guaranteed loss-at-stop or a substitute for broker-native risk limits. The result is not used to authorize entries.

The current Deriv `portfolio_response` schema includes `underlying_symbol`, `buy_price`, `payout`, `currency`, contract ID and timing/description fields; it does not define a live `profit` field. The endpoint therefore requests `proposal_open_contract` for each open position and validates its contract ID, open status, currency, purchase price, bid price, provider-reported profit and fresh `current_spot_time`. It does not invent unrealised P&L.

The current balance and portfolio response schemas do not expose a provider event timestamp for these snapshots. The returned `balance_as_of` and `portfolio_as_of` therefore mean **server receipt time** for the authenticated responses, not a Deriv exchange timestamp. The endpoint re-queries both responses on each request and limits its internal capture window; it does not label these as market tick timestamps.

This adapter does not calculate daily realized P&L, account-level available margin, margin utilization, or cross-broker exposure. The current endpoint reads current balance, current open positions and fresh open-contract valuations only. Those missing inputs must be sourced and validated separately before any portfolio risk guardian or automated entry preflight can consume them.

`open_unrealized_profit`, `open_stake_at_risk` and `balance` remain in the selected Deriv account currency. No USD FX conversion is applied. Do not feed these values into the platform-wide USD 20 profit-protection threshold until a fresh, trusted currency-conversion adapter and cross-account aggregation are implemented.

## Daily realized P&L adapter (normalizer only)

A separate strict normalizer now accepts authenticated `profit_table` response pages and calculates daily closed-contract P&L using each provider row's `sell_time`, `sell_price`, and `buy_price`:

- Include a closed contract only when `sell_time` falls within the caller-supplied half-open day interval.
- Calculate its realized result as `sell_price - buy_price`; do not use purchase date to classify the closing day.
- Require contiguous pagination from offset zero through a short terminal page. A full final page without a subsequent short/empty page is incomplete and blocks the result.
- Validate page message type/count, numeric values, timestamps, transaction IDs, contract IDs, and duplicate identifiers. Keep the account's authenticated currency; no FX conversion is attempted.
- The adapter requires the exact selected account ID and DEMO mode, preventing cross-account or REAL/DEMO mixing. The caller must supply the intended day boundaries; for the platform's daily loss policy those boundaries should be computed for the Africa/Nairobi calendar day (UTC+03:00), not assumed to be UTC midnight. The adapter is pure and read-only. It is not yet wired into the account endpoint, daily risk guardian, bot preflight, or profit-protection system.

The public request schema exposes `date_from` and `date_to` but does not define whether they filter by purchase or sell time. Therefore this adapter deliberately does not rely on those filters: its caller must fetch the full paginated history and locally classify rows by the provider's `sell_time`. If pagination cannot be completed, the adapter returns BLOCKED rather than a partial daily total. The full-history pagination strategy is intentionally conservative and may be expensive for accounts with extensive history; a future server integration must respect Deriv's shared `profit_table` request limits and avoid frequent polling.

The full-history pagination requirement is conservative but costly; it is a normalizer only and does not yet call Deriv or persist history. No live account has been used to validate its output.\n\nThis daily realized value is not yet suitable for portfolio-wide risk decisions: there is no trusted USD conversion, day-start equity baseline, MT5 adapter, or cross-broker aggregation. It must not be used as a substitute for current balance, available margin, or open-position stop risk.

## Provider-driven options contract metadata and proposal adapter

`lib/deriv/options-contract-adapter.js` adds three pure functions:

1. `normalizeDerivContractsForResponse` accepts only a `contracts_for` response for the exact requested symbol, validates required provider metadata and unique contract types, and preserves provider duration bounds as raw strings. It does not infer duration units or activate instruments.
2. `buildDerivProposalRequest` builds a schema-constrained `proposal: 1` pricing request only when the contract type is present in that symbol's provider catalogue, the account currency and stake/payout basis are valid, and barrier inputs match the provider's barrier count.
3. `normalizeDerivProposalResponse` checks the exact echoed request, provider proposal fields, quote spot timestamp freshness and any provider stake bounds. It rejects mismatched, stale, malformed or contradictory responses.

The proposal is a price quote, not an order. The adapter deliberately does not send `buy`, does not retain or expose the proposal ID in its normalized result, and always reports `sizingAuthorized:false` and `executionAuthorized:false`. If provider stake limits are absent, it returns no limits and does not treat the requested amount as validated. The proposal's `display_number_of_contracts` is not converted into lots or quantity.

This is currently a pure adapter plus unit tests. It is not connected to a live Deriv WebSocket, the bot's sizing path, paper-trade entry, or REAL execution. Contract duration bounds are retained exactly as Deriv supplied them; do not compare them numerically until the provider's unit semantics are verified for the specific expiry type. The active instrument approval registry remains a separate mandatory gate.


## Authenticated DEMO proposal retrieval endpoint

`POST /api/deriv/proposal` now connects the pure proposal adapter to a short-lived authenticated account-scoped DEMO WebSocket:

1. It authenticates the Supabase member and loads only that member's encrypted Deriv token and explicitly selected DEMO account.
2. It rechecks the selected account against Deriv's current authenticated Options account list, including exact account ID, DEMO status and account currency.
3. It requests a one-time OTP and accepts only the documented Deriv DEMO WebSocket host/path.
4. The WebSocket helper requests `contracts_for` first, validates the exact symbol response, then builds and requests `proposal: 1` using the verified account currency. Request IDs are correlated and provider errors, malformed messages, unexpected close and timeout fail closed.
5. The endpoint returns sanitized quote details only. It never returns the access token, OTP, proposal ID or raw provider payload, and it never sends `buy` or `sell`.

Request fields are symbol, catalogue-listed contract type, amount, stake/payout basis, duration, optional duration unit and any required barrier values. Currency is never accepted from the browser. Proposal retrieval is informational and is not instrument approval, position sizing, paper-trade entry or order authorization. `sizing_authorized` and `execution_authorized` are always false; REAL trading remains disabled.

The route and WebSocket helper have regression tests, but the flow has not yet been exercised against Deriv's live DEMO sandbox or connected to the existing bot entry path. Provider duration semantics remain unverified and are not inferred. The active instrument approval registry remains mandatory for any future trading integration.
