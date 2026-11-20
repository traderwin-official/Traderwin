# Traderwin release readiness

This branch is isolated from the live main branch. PR #3 remains draft and unmerged.

## Current verified progress
- Supabase email/password authentication and first-login DEMO/REAL preference flow.
- Multi-market schema, separate bot mode profiles, per-user risk settings and audit records.
- Server-side Deriv public quote adapter for a limited allow-list of supported instruments. DEMO entry, mark and close requests use fresh server quotes, not browser-entered prices.
- Server-side Deriv OHLC candle adapter and authenticated rule-based market analyst (EMA, RSI, ATR, momentum and breakout confirmations). It returns research only and does not execute trades.
- Deriv OAuth flow now requests the trade scope, verifies the user's active demo account through the Deriv accounts API, encrypts the token server-side and records its expiry.
- M-Pesa payment ledger and STK Push scaffolding. REAL subscription price is USD 75 for the first paid month and USD 175 for subsequent monthly renewals; the server calculates KES at checkout and stores the FX snapshot.
- Subscription status endpoint reports expiry and keeps manual renewal as the default.
- Shared portfolio profit-protection calculation, persistent state schema, emergency-control foundations and tests.
- GitHub Actions passes unit tests, serverless syntax checks and inline-script checks on Node 22.

## Not yet operational
- A scheduled DEMO-only auto worker is implemented on this branch. It requires migration 016, `CRON_SECRET` in Vercel, Supabase `pg_cron` + `pg_net` + Vault setup using `docs/DEMO_WORKER_SCHEDULING.md`, and a verified dashboard heartbeat before it can be called operational. It currently supports Deriv only, one open virtual position per user, and the validated multi-confirmation strategy. It does not manage manual positions or REAL trades. Stopping new entries pauses the session while an existing BOT position remains under stop/target management; the kill switch blocks new entries without disabling that risk-reducing management.
- The live-market analyst is not an AI agent with broad global news/sentiment access; it is a rule-based technical analyst using Deriv candles. It does not place trades.
- The 20% combined portfolio profit-protection monitor is not wired to a persistent worker or live broker adapters. Do not rely on it to close positions.
- MT5 bridge/quotes/execution are not connected.
- REAL broker order execution remains locked. Payment or selecting REAL never authorizes trading.
- Automatic renewal is not enabled. The current M-Pesa STK Push requires customer confirmation for each payment; manual renewal is the default.
- Daraja production credentials and callback URL are not confirmed.
- Supabase migrations 002-016 are not confirmed applied to the live project; only migration 001 was previously confirmed by the owner.
- Vercel deployment is currently blocked by the account deployment API rate limit. Wait for the provider's stated retry window; do not bypass it.

## BLOCKED: production Supabase schema reconciliation required

**Do not run the migration list below against the existing production Supabase project yet.** The owner supplied a live table/column inventory that differs materially from this branch's original schema assumptions. In particular:

- Production `bot_settings.id` is BIGINT, while this branch's original migrations attempted to assign `gen_random_uuid()`; migrations 002 and 012 now guard that default so it is applied only when the column is UUID.
- Production `demo_bot_sessions` uses the newer session model (`broker`, `broker_account_ref`, `instrument`, `strategy`, `status`, `risk_per_trade_pct`, `max_daily_loss_pct`, timestamps) and does not match the older paper-ledger model assumed by this branch (`bot_setting_id`, `account_mode`, `starting_balance`, `current_balance`, etc.).
- Production `demo_bot_trades` uses `instrument/side/quantity/pnl`; this branch's DEMO worker expects `symbol/direction/virtual_units/realized_pnl/quote_source/quote_as_of` and other ledger fields.
- Production `bot_activity` and `bot_mode_profiles` also have a different column contract from several branch endpoints and worker SQL functions.

The UUID-default guard is a narrow compatibility correction, **not** a complete schema migration. Do not deploy the DEMO endpoints or run migrations 005-016 until a new additive reconciliation migration has been designed against the complete live columns, constraints, indexes, and RLS policies. Never drop or rename existing production columns or tables to force compatibility.

## Historical branch migration sequence — NOT APPROVED FOR PRODUCTION
The following is the original branch sequence for a clean/compatible database only. It is not an instruction to run these migrations against the owner's current Supabase project:
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
16. `supabase/migrations/202611120016_demo_auto_worker.sql`

Do not skip, reorder, or assume migrations have run because GitHub tests pass. The live Supabase project must be migrated before runtime verification.

## Required Vercel environment variables
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never in browser code).
- Worker: `CRON_SECRET` (long random server-side secret; Supabase Cron reads the matching value from Vault and sends it as the authorization header).
- Deriv: `DERIV_CLIENT_ID`, `DERIV_REDIRECT_URI`, `DERIV_OAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` (exactly 64 hex characters / 32 bytes). The Deriv OAuth application must allow the `trade` scope and the exact HTTPS callback URL.
- M-Pesa: `MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL`, and optional `MPESA_TRANSACTION_TYPE`. Daraja merchant approval and a publicly reachable HTTPS callback are required.

Never paste secrets into chat, GitHub source, or browser-visible environment variables. Add them only through Vercel's server-side environment settings.

## Safe release gates
1. Apply and verify migrations 002-016 in Supabase.
2. Configure server-side credentials and registered Deriv/M-Pesa callback URLs.
3. Wait for Vercel's deployment rate limit to clear, then create a preview deployment.
4. Test signup/login, onboarding, public market data, server-side DEMO quote entry/mark/close, strategy analysis, payment prompt, provider-confirmed payment and subscription expiry.
5. Keep the PR draft until the preview and database runtime tests pass.
6. Enable Supabase `pg_cron`, `pg_net` and Vault, store the worker URL/secret in Vault, schedule the one-minute job, then verify the DEMO worker heartbeat and test virtual open/mark/stop/target close, daily loss lock and kill-switch behaviour in the deployed preview.
7. Do not merge or enable REAL execution until MT5/Deriv execution adapters, subscription enforcement, account-level risk controls, broker-native protective stops, portfolio giveback worker and independent end-to-end tests are complete.

## Product safety
DEMO is free and uses virtual balances. REAL subscription payment only grants eligibility to proceed through broker verification and explicit authorization; it never starts live trading. No profitability or win-rate guarantee is made.

## DEMO paper ledger v2 implementation checkpoint (2026-11-20)

The upgrade branch now contains an additive `demo_paper_*` ledger migration and coordinated DEMO route/worker changes. It is intentionally isolated from the deployed legacy DEMO tables. The branch remains a draft and must not be merged or deployed until the new migration is applied to a disposable copy of the production schema and SQL/API integration tests verify the full lifecycle. Production Supabase and Vercel have not been changed.
