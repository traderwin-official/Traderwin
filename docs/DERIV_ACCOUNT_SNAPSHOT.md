# Deriv authenticated account snapshot

**Status:** read-only endpoint and strict normalizers added; not wired into bot entry, sizing, margin or portfolio-risk decisions.

## Flow

1. Authenticate the caller with Supabase and load only that user's encrypted Deriv connection.
2. Require a fresh OAuth token, the user's explicitly selected active DEMO account, and matching server-stored verified account metadata.
3. Decrypt the access token server-side. Recheck the selected account against Deriv's authenticated account list.
4. Request a short-lived OTP for that exact account, and accept only Deriv's documented `wss://api.derivws.com/trading/v1/options/ws/demo` URL.
5. Request `balance` and `portfolio` on that authenticated account-scoped WebSocket session.
6. Validate account identity, numeric balance, currency, open-contract fields, duplicate IDs and snapshot freshness. Return only sanitized account data with no-store caching.

The endpoint never connects to the REAL WebSocket, sends buy/sell/proposal messages, changes account selection, stores balance data, or authorizes execution. The OAuth token and OTP are never returned to the browser or logged.

## Important boundaries

- Deriv documents `balance` as an authenticated account endpoint and `portfolio` as the list of open positions for the authenticated account. The OTP endpoint returns a ready-to-use account-scoped WebSocket URL and the OTP is single-use and short-lived.
- This account snapshot is useful for account monitoring. It is not a complete margin model or a verified FX/CFD contract specification.
- The Options portfolio may contain contract values for options positions. Do not reinterpret an options stake or payout as MT5 lots, CFD notional, margin, or stop-loss risk.
- No DEMO entry route currently consumes this snapshot. No REAL route consumes it. A separate, broker-specific contract and risk adapter plus end-to-end sandbox validation is still required.

## Open options exposure

The endpoint also returns a conservative read-only `open_stake_at_risk` value: the sum of provider-reported `buy_price` values for all open Deriv Options contracts, with a same-currency check. This is an options premium/stake exposure summary, not a margin estimate, CFD/FX notional, guaranteed loss-at-stop or a substitute for broker-native risk limits. The result is not used to authorize entries.

The current Deriv `portfolio_response` schema includes `underlying_symbol`, `buy_price`, `payout`, `currency`, contract ID and timing/description fields; it does not define a live `profit` field. The normalizer therefore does not invent unrealised P&L. Live contract valuation requires a separately validated `proposal_open_contract` request/subscription before it can be used in profit protection.
