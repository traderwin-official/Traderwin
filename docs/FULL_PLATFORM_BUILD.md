# Traderwin full platform build

## Six connected areas
1. **Markets:** Forex, binary, crypto, commodities, indices and stocks. Seeded symbols are a directory, not live quotes.
2. **Broker connections:** Deriv and MT5. Only non-secret metadata is stored in Supabase; OAuth tokens stay encrypted server-side.
3. **Account modes:** DEMO/REAL preference and risk limits. REAL selection never authorizes an order.
4. **Bots:** Per-user bot preferences and activity audit. Automation remains off until a broker-specific demo engine, order validation, kill switch and tests are complete.
5. **AI analyst and signals:** Structured ideas with entry, SL, multiple targets, confidence, evidence timestamps and freshness fields. Human review is required before publication.
6. **Business operations:** M-Pesa payment ledger, separate service catalogue, subscriptions, courses, enrolments and admin-role foundation. M-Pesa checkout scaffolding stays unavailable until Daraja credentials and merchant settings are configured.

## Database setup
Run in Supabase SQL Editor, in this order:
1. `supabase/migrations/202611120001_trader_profiles.sql`
2. `supabase/migrations/202611120002_platform_foundation.sql`
3. `supabase/migrations/202611120003_deriv_connection_security.sql`
4. `supabase/migrations/202611120004_service_catalog_security.sql`
5. `supabase/migrations/202611120005_demo_paper_trading.sql`
6. `supabase/migrations/202611120006_dual_modes_profit_protection.sql`
7. `supabase/migrations/202611120007_shared_profit_protection.sql`
8. `supabase/migrations/202611120008_portfolio_profit_protection.sql`
9. `supabase/migrations/202611120009_portfolio_membership_tracking.sql`
10. `supabase/migrations/202611120010_atomic_portfolio_state.sql`
11. `supabase/migrations/202611120011_bot_emergency_controls.sql`
12. `supabase/migrations/202611120012_legacy_schema_compatibility.sql`
13. `supabase/migrations/202611120013_broker_metadata_write_lock.sql`
14. `supabase/migrations/202611120014_usd_subscription_pricing.sql`
15. `supabase/migrations/202611120015_deriv_account_verification.sql`

Migration 002 now adds the broker metadata aliases and UUID defaults needed by older Traderwin schemas before its column-level grants. Migration 012 remains a final idempotent compatibility pass. Migration 013 explicitly revokes legacy browser column-level writes to broker connection identifiers. Migration 014 adds USD subscription pricing and payment FX snapshots; Migration 015 adds verified Deriv demo/real account IDs and OAuth expiry. Check each SQL result and verify the new tables in Table Editor before deployment. Do not skip or reorder migrations.

## Credentials and external services still needed
- Deriv OAuth app `DERIV_CLIENT_ID`, registered HTTPS `DERIV_REDIRECT_URI`, `DERIV_OAUTH_SECRET` (cookie-signing secret), and a 32-byte hex `TOKEN_ENCRYPTION_KEY`. The OAuth app must have the `trade` scope enabled. The callback verifies the user's active demo account via Deriv before marking the connection complete. Deriv access tokens expire; there is no refresh token, so users must reconnect after expiry. The private `deriv_connections` table depends on migrations 003 and 015.
- MT5 broker/server and a secure hosted bridge; a browser cannot connect directly to a desktop MT5 terminal.
- A licensed market-data provider for live prices.
- Vercel server-side variables: `MPESA_ENV` (`sandbox` or `production`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL` (for example `https://YOUR-DOMAIN/api/payments/mpesa/callback`) and optional `MPESA_TRANSACTION_TYPE`. Also configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in Vercel. Daraja merchant approval is required. The server-side STK endpoint reads prices from the catalogue; the callback re-queries Daraja before marking an order PAID. Never confirm payment from the browser.
- AI provider key and legal market/news data sources, stored only as Vercel server-side environment variables.
- Admin roles assigned through trusted server-side operations, never self-service.

## Safety rules
REAL mode is only a preference; bots default OFF; no live-order endpoint is enabled by this migration; no broker secrets are stored in client-readable tables; payment confirmation is server-only; AI ideas need provenance, freshness checks and human approval. Use demo accounts for all integration testing.


## Demo paper simulator

The DEMO simulator uses a virtual USD 10,000 balance and a server-controlled paper-trade ledger. It requires the signed-in profile and saved bot settings to both be in DEMO mode. Entry, mark and close prices for the currently supported Deriv instruments are fetched by the server from Deriv public market data; browser-supplied prices are ignored. Each quote is checked against Deriv active symbols and its timestamp before the ledger accepts it. MT5 quotes and a full instrument-contract specification/valuation layer are not connected. Virtual units and P/L remain simplified educational estimates, not broker lot sizes or executable broker orders. The session is still a paper ledger, not an unattended auto-trading worker.

## Both account modes and profit protection

Traderwin now has a separate preference profile for each user in both DEMO and REAL mode. The active account mode remains an explicit dashboard/onboarding choice; saving a REAL profile does not authorize execution. The real-execution authorization table is inaccessible to browser roles and defaults to LOCKED. No live-order endpoint is included.

The shared strategy analysis uses EMA(9/21), RSI(14), ATR(14), a 20-candle breakout check and price-versus-EMA confirmation. The authenticated market-analysis endpoint fetches completed OHLC candles server-side from Deriv for supported instruments/timeframes and returns BUY, SELL or WAIT with indicators and an evidence explanation. This is a rule-based analyst, not a general-purpose AI model, and it cannot execute orders or guarantee outcomes.

Portfolio-level profit protection aggregates unrealised P&L across open positions in one user/broker-account/account-mode scope, normalized to USD by a verified server-side valuation adapter. The USD 20 activation threshold applies to the combined portfolio, not each position. Automatic bot positions are included; manually opened positions are excluded unless the owner explicitly enables Monitor and Manage Manual Trades for that exact account. Monitoring-only permission never authorizes closing. DEMO and REAL have separate peak records. The pure aggregation helper validates that positions cannot be mixed across users, broker accounts or account modes. It tracks the exact included-position set; if manual-management permission is added or revoked, the portfolio peak baseline resets for the new managed set so an old peak cannot unexpectedly close remaining positions. The persistent worker must save the included position IDs and increment the membership version atomically whenever that set changes. The current branch adds the calculation and permission/state schema foundation, but a persistent broker worker and close adapter are still required before this can manage real positions. Once active, it closes at a 20% giveback from the maximum unrealised profit. Example: a trade reaches USD 100 unrealised profit; the protection floor is USD 80. A later mark at or below USD 80 triggers a paper exit. The protective stop is only tightened, never loosened. Broker-side stop modification, spreads, commissions, gaps and slippage must be handled by the specific Deriv/MT5 adapter before the same policy can protect a live position. The current DEMO mark endpoint requires a supplied price, so it is a manual paper-test control until a verified streaming feed and worker are connected.

## REAL execution gate

The platform keeps a REAL profile available alongside DEMO, but real execution remains LOCKED. Before any live-order implementation can be enabled, the system must verify the broker account and its DEMO/REAL environment, require a fresh risk acknowledgement, apply server-side risk checks, use broker-native protective stops where supported, enforce an emergency kill switch and pass broker sandbox/DEMO testing. Users must separately opt in; a REAL profile or connected OAuth account alone never places an order.

## Live DEMO market chart foundation

The dashboard opens Deriv's public WebSocket market-data endpoint (wss://api.derivws.com/trading/v1/options/ws/public) to load active symbols and stream ticks. The server-side DEMO quote adapter independently requests a fresh tick for entry/mark/close, and the strategy analyst fetches completed OHLC candles. These public endpoints do not require account authentication; they cannot place trades or read balances. The live chart is market data only and is not an executable MT5 quote. The current supported-symbol map is limited; unsupported instruments fail closed. A persistent worker, instrument contract specifications, quote-currency conversion, spread/commission treatment and broker adapters remain required for continuous automation and reliable risk management.


## Server-side portfolio monitoring coordinator

The branch now includes `lib/portfolio-monitor.js`, a broker-agnostic coordinator designed for a persistent server worker. It requires injected adapters for a fresh account-scoped snapshot, USD-normalized P&L, persisted protection state, explicit permissions, compare-and-swap state persistence, and broker close requests. Stale or malformed quotes, mixed account positions, missing permissions, invalid valuation, and concurrent state-version conflicts stop processing without a close. REAL close requests additionally require a separate server-side real-execution authorization check. Close requests are processed per position with idempotency keys and partial failures returned for retry; this is not an atomic multi-position broker operation.

This coordinator is an integration boundary, not a running worker: no Deriv/MT5 position adapter, trusted valuation service, scheduled worker, or real-order endpoint is wired to it yet. It must not be described as active account protection until those components are implemented and verified. A worker should persist broker-confirmed close outcomes and reconcile positions after every request.


## Atomic portfolio state and account permissions

Migration `202611120010_atomic_portfolio_state.sql` adds quote provenance fields, explicit per-account `bot_trade_management` and `close_managed_positions` permissions, and a service-role-only compare-and-swap RPC. The RPC creates a new state row only from expected state version zero and updates an existing row only when its stored state version matches the caller's expected version. A separate monotonic state_version increments on every successful save, while membership_version changes only when the included-position set changes. This prevents concurrent valuation workers from silently overwriting a newer peak/membership snapshot.

`lib/supabase-portfolio-adapters.js` maps the coordinator to server-side Supabase state and permission records. Missing permission rows default to no bot management, no manual management and no closing authority. REAL authorization is checked separately against the server-only authorization record. Broker snapshot and close adapters remain injected; they are not implemented by this helper.

Before applying migration 010, review and apply compatible migrations 008 and 009 in order. The migration is not yet confirmed applied in the live Supabase project. Do not enable any closing permission until verified broker adapters, position valuation, idempotent close/reconciliation and user-facing permission controls are complete.


## Emergency protection layer

The branch adds a fail-safe emergency guard in `lib/emergency-guard.js`. It separates permission to open new risk from permission to reduce existing risk. A kill switch halts new entries but does not block authorized exits when the market feed, broker connection and broker heartbeat are healthy. If the broker is disconnected, stale or future-dated quotes are detected, or the broker heartbeat is stale, the monitor blocks close requests rather than claiming an order was executed; broker-native protective stops are therefore essential for REAL positions wherever the broker/instrument supports them.

For REAL positions, the guard requires each open position to report `protectiveStopVerified: true` before new entries are allowed. Missing verification halts new entries and reports the affected position IDs, while still allowing risk-reducing actions if connectivity is healthy. DEMO paper positions do not require broker-native stops. The monitor now requires explicit emergency connection/heartbeat status in each snapshot and blocks if that status is missing or unhealthy. This is a tested safety gate, not a deployed kill-switch UI, broker-side stop installer, always-on worker, or guarantee against gaps/slippage. The broker adapter must verify stop acceptance and reconcile actual positions after reconnect before automation resumes.


## Per-account emergency entry-stop control

Migration `202611120011_bot_emergency_controls.sql` creates a service-role-only, per-user/account/mode emergency latch. The authenticated API route `POST /api/bots/emergency/control` supports `STATUS`, `STOP_ENTRIES`, and `CLEAR_STOP`. DEMO uses the server-defined reference `DEMO:<authenticated-user-id>`; REAL requires a matching broker connection marked CONNECTED with a verification timestamp. The control only blocks new entries. It never closes open positions, never grants close permission, and clearing the latch does not bypass quote freshness, broker heartbeat, risk limits, protective-stop verification or REAL execution authorization. This endpoint is an API foundation; the actual background bot worker must read the latch before every entry. REAL account control will remain unavailable until the broker adapter writes a verified `broker_connections` record.


## REAL subscription and payments

The service catalogue now includes a separate REAL_TRADING monthly service priced at USD 75 for the first paid month and USD 175 for subsequent monthly renewals. DEMO remains free. The M-Pesa STK endpoint calculates the KES amount server-side using a fresh USD/KES rate, rounds the amount up to the next whole shilling, and stores the USD amount, FX rate, source, timestamp and price basis on the payment order. A prior confirmed paid order for this service selects the renewal price. A partial unique index prevents simultaneous pending payment prompts for the same user/service. Early manual renewal extends from the current subscription expiry instead of shortening it.

The authenticated subscription-status endpoint returns expiry and MANUAL renewal mode. Manual renewal is the default. Automatic renewal is not active because the current STK Push flow is customer-confirmed, not a recurring debit mandate; do not advertise automatic charging until a supported recurring-payment arrangement, explicit consent flow, cancellation and failed-payment handling are implemented. Payment alone never enables REAL order execution.

M-Pesa still requires approved Daraja merchant credentials, a production callback URL, and Vercel environment variables. Do not put merchant secrets or Supabase service-role credentials in browser code.
