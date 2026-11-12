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

Check each SQL result and verify the new tables in Table Editor before deployment.

## Credentials and external services still needed
- Deriv application credentials and approved redirect URI. The new status/disconnect endpoints depend on the private `deriv_connections` table from migration 003.
- MT5 broker/server and a secure hosted bridge; a browser cannot connect directly to a desktop MT5 terminal.
- A licensed market-data provider for live prices.
- Vercel server-side variables: `MPESA_ENV` (`sandbox` or `production`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL` (for example `https://YOUR-DOMAIN/api/payments/mpesa/callback`) and optional `MPESA_TRANSACTION_TYPE`. Also configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in Vercel. Daraja merchant approval is required. The server-side STK endpoint reads prices from the catalogue; the callback re-queries Daraja before marking an order PAID. Never confirm payment from the browser.
- AI provider key and legal market/news data sources, stored only as Vercel server-side environment variables.
- Admin roles assigned through trusted server-side operations, never self-service.

## Safety rules
REAL mode is only a preference; bots default OFF; no live-order endpoint is enabled by this migration; no broker secrets are stored in client-readable tables; payment confirmation is server-only; AI ideas need provenance, freshness checks and human approval. Use demo accounts for all integration testing.


## Demo paper simulator

The DEMO simulator uses a virtual USD 10,000 balance and a server-controlled paper-trade ledger. It requires the signed-in profile and saved bot settings to both be in DEMO mode. Prices are manually supplied by the user until a verified market-data feed and instrument contract specifications are integrated. Virtual units and P/L are simplified educational estimates, not broker lot sizes, executable quotes or automated strategy signals. No endpoint in this layer sends a broker order.

## Both account modes and profit protection

Traderwin now has a separate preference profile for each user in both DEMO and REAL mode. The active account mode remains an explicit dashboard/onboarding choice; saving a REAL profile does not authorize execution. The real-execution authorization table is inaccessible to browser roles and defaults to LOCKED. No live-order endpoint is included.

The shared strategy analysis uses EMA(9/21), RSI(14), ATR(14), a 20-candle breakout check and price-versus-EMA confirmation. It returns BUY, SELL or WAIT with indicators and an evidence explanation. It analyses supplied completed OHLC candles only; it is not yet connected to a licensed live feed and cannot execute orders.

Portfolio-level profit protection aggregates unrealised P&L across open positions in one user/broker-account/account-mode scope, normalized to USD by a verified server-side valuation adapter. The USD 20 activation threshold applies to the combined portfolio, not each position. Automatic bot positions are included; manually opened positions are excluded unless the owner explicitly enables Monitor and Manage Manual Trades for that exact account. Monitoring-only permission never authorizes closing. DEMO and REAL have separate peak records. The pure aggregation helper validates that positions cannot be mixed across users, broker accounts or account modes. It tracks the exact included-position set; if manual-management permission is added or revoked, the portfolio peak baseline resets for the new managed set so an old peak cannot unexpectedly close remaining positions. The persistent worker must save the included position IDs and increment the membership version atomically whenever that set changes. The current branch adds the calculation and permission/state schema foundation, but a persistent broker worker and close adapter are still required before this can manage real positions. Once active, it closes at a 20% giveback from the maximum unrealised profit. Example: a trade reaches USD 100 unrealised profit; the protection floor is USD 80. A later mark at or below USD 80 triggers a paper exit. The protective stop is only tightened, never loosened. Broker-side stop modification, spreads, commissions, gaps and slippage must be handled by the specific Deriv/MT5 adapter before the same policy can protect a live position. The current DEMO mark endpoint requires a supplied price, so it is a manual paper-test control until a verified streaming feed and worker are connected.

## REAL execution gate

The platform keeps a REAL profile available alongside DEMO, but real execution remains LOCKED. Before any live-order implementation can be enabled, the system must verify the broker account and its DEMO/REAL environment, require a fresh risk acknowledgement, apply server-side risk checks, use broker-native protective stops where supported, enforce an emergency kill switch and pass broker sandbox/DEMO testing. Users must separately opt in; a REAL profile or connected OAuth account alone never places an order.

## Live DEMO market chart foundation

The dashboard now opens Deriv's public WebSocket market-data endpoint (wss://api.derivws.com/trading/v1/options/ws/public) to load active symbols and stream ticks for the selected Deriv instrument. Deriv documents active_symbols and ticks as public, no-auth market-data operations. The live chart is a market-data display only: it does not place orders, establish the user's broker execution connection, or make a TradingView quote equivalent to a Deriv/MT5 execution quote. Instruments not listed by Deriv are not offered by this feed. Before automatic DEMO P/L marking or REAL risk management is enabled, add verified instrument contract specifications, quote-currency conversion, spread/commission treatment, and a persistent server-side worker that continues monitoring when the member closes the browser.


## Server-side portfolio monitoring coordinator

The branch now includes `lib/portfolio-monitor.js`, a broker-agnostic coordinator designed for a persistent server worker. It requires injected adapters for a fresh account-scoped snapshot, USD-normalized P&L, persisted protection state, explicit permissions, compare-and-swap state persistence, and broker close requests. Stale or malformed quotes, mixed account positions, missing permissions, invalid valuation, and concurrent state-version conflicts stop processing without a close. REAL close requests additionally require a separate server-side real-execution authorization check. Close requests are processed per position with idempotency keys and partial failures returned for retry; this is not an atomic multi-position broker operation.

This coordinator is an integration boundary, not a running worker: no Deriv/MT5 position adapter, trusted valuation service, scheduled worker, or real-order endpoint is wired to it yet. It must not be described as active account protection until those components are implemented and verified. A worker should persist broker-confirmed close outcomes and reconcile positions after every request.


## Atomic portfolio state and account permissions

Migration `202611120010_atomic_portfolio_state.sql` adds quote provenance fields, explicit per-account `bot_trade_management` and `close_managed_positions` permissions, and a service-role-only compare-and-swap RPC. The RPC creates a new state row only from expected version zero and updates an existing row only when its stored membership version matches the caller's expected version. This prevents concurrent valuation workers from silently overwriting a newer peak/membership snapshot.

`lib/supabase-portfolio-adapters.js` maps the coordinator to server-side Supabase state and permission records. Missing permission rows default to no bot management, no manual management and no closing authority. REAL authorization is checked separately against the server-only authorization record. Broker snapshot and close adapters remain injected; they are not implemented by this helper.

Before applying migration 010, review and apply compatible migrations 008 and 009 in order. The migration is not yet confirmed applied in the live Supabase project. Do not enable any closing permission until verified broker adapters, position valuation, idempotent close/reconciliation and user-facing permission controls are complete.
