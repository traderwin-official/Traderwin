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
