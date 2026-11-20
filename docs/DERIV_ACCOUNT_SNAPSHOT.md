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

- Include a closed contract only when `sell_time` falls within the requested UTC half-open day interval.
- Calculate its realized result as `sell_price - buy_price`; do not use purchase date to classify the closing day.
- Require contiguous pagination from offset zero through a short terminal page. A full final page without a subsequent short/empty page is incomplete and blocks the result.
- Validate page message type/count, numeric values, timestamps, transaction IDs, contract IDs, and duplicate identifiers. Keep the account's authenticated currency; no FX conversion is attempted.
- The adapter is pure and read-only. It is not yet wired into the account endpoint, daily risk guardian, bot preflight, or profit-protection system.

The public request schema exposes `date_from` and `date_to` but does not define whether they filter by purchase or sell time. Therefore this adapter deliberately does not rely on those filters: its caller must fetch the full paginated history and locally classify rows by the provider's `sell_time`. If pagination cannot be completed, the adapter returns BLOCKED rather than a partial daily total. The full-history pagination strategy is intentionally conservative and may be expensive for accounts with extensive history; a future server integration must respect Deriv's shared `profit_table` request limits and avoid frequent polling.

This daily realized value is not yet suitable for portfolio-wide risk decisions: there is no trusted USD conversion, day-start equity baseline, MT5 adapter, or cross-broker aggregation. It must not be used as a substitute for current balance, available margin, or open-position stop risk.
