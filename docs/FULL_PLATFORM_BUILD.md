# Traderwin full platform build

## Six connected areas
1. **Markets:** Forex, binary, crypto, commodities, indices and stocks. Seeded symbols are a directory, not live quotes.
2. **Broker connections:** Deriv and MT5. Only non-secret metadata is stored in Supabase; OAuth tokens stay encrypted server-side.
3. **Account modes:** DEMO/REAL preference and risk limits. REAL selection never authorizes an order.
4. **Bots:** Per-user bot preferences and activity audit. Automation remains off until a broker-specific demo engine, order validation, kill switch and tests are complete.
5. **AI analyst and signals:** Structured ideas with entry, SL, multiple targets, confidence, evidence timestamps and freshness fields. Human review is required before publication.
6. **Business operations:** M-Pesa payment ledger, separate service catalogue, subscriptions, courses, enrolments and admin-role foundation.

## Database setup
Run in Supabase SQL Editor, in this order:
1. `supabase/migrations/202611120001_trader_profiles.sql`
2. `supabase/migrations/202611120002_platform_foundation.sql`
3. `supabase/migrations/202611120003_deriv_connection_security.sql`

Check each SQL result and verify the new tables in Table Editor before deployment.

## Credentials and external services still needed
- Deriv application credentials and approved redirect URI. The new status/disconnect endpoints depend on the private `deriv_connections` table from migration 003.
- MT5 broker/server and a secure hosted bridge; a browser cannot connect directly to a desktop MT5 terminal.
- A licensed market-data provider for live prices.
- M-Pesa Daraja credentials, callback URL and merchant setup. Never confirm payment from the browser.
- AI provider key and legal market/news data sources, stored only as Vercel server-side environment variables.
- Admin roles assigned through trusted server-side operations, never self-service.

## Safety rules
REAL mode is only a preference; bots default OFF; no live-order endpoint is enabled by this migration; no broker secrets are stored in client-readable tables; payment confirmation is server-only; AI ideas need provenance, freshness checks and human approval. Use demo accounts for all integration testing.
