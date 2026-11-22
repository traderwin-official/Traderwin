# Young Tiger Forex Platform — upgrade readiness

This document describes the isolated integration branch `integration/young-tiger-platform` and its draft PR #33. It is not the live production deployment. No production Supabase migration or production Vercel deployment has been performed.

## Current verified progress

- Young Tiger FX branding is applied across the public dashboard, authentication, onboarding and bot-shop pages.
- Supabase authentication and the DEMO/REAL onboarding preference flow remain in the platform foundation.
- Deriv public quote and OHLC adapters provide verified market data for a limited supported-instrument allow-list. Unsupported instruments or unavailable USD conversions fail closed.
- The authenticated technical analyst (EMA, RSI, ATR, momentum and breakout confirmations) remains research-only; it does not execute trades.
- Deriv OAuth uses PKCE and signed, short-lived HttpOnly state; access tokens are encrypted server-side. The callback stores only sanitized verified account metadata, requests `trade` and `account_manage`, and never silently selects among multiple DEMO accounts. Authenticated account-list and DEMO-only selection endpoints are now present. REAL account identifiers may be recorded as verification metadata, but REAL selection and execution remain locked.
- M-Pesa payment ledger and STK Push scaffolding remain in place. REAL subscription pricing is USD 75 for the first paid month and USD 175 for subsequent monthly renewals. Payment grants eligibility only; it never authorizes live trading.
- A new isolated DEMO paper ledger (`demo_paper_*`) is implemented without altering the legacy production `demo_bot_*` tables.
- The ledger supports multiple open MANUAL virtual positions alongside one BOT-managed strategy position. Default cap is 3 simultaneous positions (maximum 10); combined open risk is capped at 2% of virtual balance.
- The dashboard returns and displays `openTrades[]`, preserves the old `openTrade` response alias, and allows members to select a position to mark or close.
- The combined DEMO portfolio giveback monitor is connected to the worker endpoint. It tracks the highest simultaneous combined unrealized USD P&L snapshot, activates at USD 20, and protects 80% of that peak. It does not sum independent position highs from different times.
- Automatic BOT positions are included by default for DEMO. MANUAL positions are excluded until the member explicitly enables monitoring; automatic closing of manual positions requires a separate explicit permission.
- Portfolio closes use a server-only RPC that locks the permission row, checks the exact instrument and account, and stores an idempotency key. Manual permission revocation and portfolio closing serialize safely.
- The DEMO worker is invoked by Supabase Cron through `pg_net` and Supabase Vault. The Vercel deployment only hosts `/api/cron/demo-auto-worker`; it does not run a second Vercel Cron schedule. The route requires a server-side `CRON_SECRET` of at least 32 characters.
- GitHub Actions has passed JavaScript tests, serverless syntax checks, inline page-script checks, and the isolated DEMO/portfolio migration and SQL integration checks against disposable PostgreSQL 16 at the current integration checkpoint. This does not verify the live Supabase Auth/PostgREST/RLS environment.

## Current limitations — not yet operational

- The new SQL migrations have passed disposable PostgreSQL CI, but they have **not** been applied to the owner's live Supabase project. Supabase Auth, PostgREST, RLS and actual project schema behavior still need verification in a disposable Supabase project.
- The DEMO worker is Deriv-only and supports instruments for which a verified USD conversion exists. It currently allows one BOT strategy position per session plus multiple MANUAL virtual positions; multiple simultaneous BOT instruments are not yet supported.
- Manual positions currently mean MANUAL virtual trades recorded in the DEMO paper ledger. The monitor does not yet import manually opened positions from a live Deriv or MT5 account.
- The combined giveback monitor is DEMO-only. It does not send broker orders. REAL portfolio monitoring and closing remain locked until secure Deriv/MT5 account-position adapters and live close permissions are independently tested.
- Supabase Cron scheduling is not active until the owner configures `pg_cron`, `pg_net`, Vault secrets and the scheduled job in the target Supabase project. Do not create a parallel Vercel Cron job. The worker is DEMO-only and is not a REAL trading execution clock.
- The dashboard has CI/static validation but still needs browser preview testing against a disposable Supabase environment.
- MT5 account connection, quotes and execution are not connected.
- Daraja production credentials, callback URL, webhook verification and merchant approval are not confirmed.
- Automatic subscription renewal is not enabled. M-Pesa STK Push requires customer confirmation; manual renewal remains the default.
- The broad migration history from the original branch is not approved for production. Do not run historical migrations 005–016 against the owner's current Supabase schema.

## Production schema compatibility

The owner supplied a production table/column inventory that differs from the original upgrade branch assumptions:

- Production `bot_settings.id` is BIGINT, not UUID.
- Production `demo_bot_sessions` and `demo_bot_trades` use the legacy deployed schema, not the earlier paper-ledger model.
- Existing production `bot_activity`, `bot_mode_profiles` and broker tables have their own established contracts.

The new DEMO paper ledger is deliberately isolated in `demo_paper_sessions`, `demo_paper_trades`, worker lease/heartbeat tables and emergency-control storage. It does not drop, rename or retrofit the legacy DEMO tables. The portfolio migration adds columns to the existing `portfolio_profit_protection_state` foundation table and creates a new service-role-only `portfolio_trade_permissions` table.

## New additive migration sequence — disposable Supabase first

Apply these only to a disposable Supabase project after verifying that the existing foundation table matches the supplied production inventory:

1. `supabase/migrations/202611200001_demo_paper_ledger_v2.sql`
2. `supabase/migrations/202611200002_portfolio_protection_state_v2.sql`
3. `supabase/migrations/202611200003_demo_multi_position_v3.sql`
4. `supabase/migrations/202611200004_demo_portfolio_close_authorization.sql`
5. `supabase/migrations/202611200005_deriv_verified_account_selection.sql`
6. `supabase/migrations/202611200006_trading_instrument_approval_registry.sql`
7. `supabase/migrations/202611210001_demo_paper_daily_realization_events.sql`

Do not apply the historical branch migrations 005–016 to production. Never drop or rename existing production tables or columns to force compatibility. The disposable PostgreSQL CI bootstrap is a validation fixture, not a substitute for a disposable Supabase project.

## Required server-side environment

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-side only).
- Worker: `CRON_SECRET` (at least 32 random characters). Supabase Cron reads the same secret from Vault and sends it as the `Authorization: Bearer ...` header through `pg_net`.
- REAL execution: keep `REAL_EXECUTION_ENABLED` unset or `false`. The portfolio adapter also requires this server-side release switch in addition to a complete `AUTHORIZED` database record; do not set it to `true` before independent end-to-end testing and explicit owner approval.
- Deriv: `DERIV_CLIENT_ID`, `DERIV_REDIRECT_URI`, `DERIV_OAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` (exactly 64 hex characters / 32 bytes).
- M-Pesa: `MPESA_ENV`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL`, and optional `MPESA_TRANSACTION_TYPE`.

Never paste secrets into chat, GitHub source, or browser-visible environment variables. Add them only through Vercel's server-side environment settings. The worker URL and secret must be stored in Supabase Vault. Never put the secret in the URL, source code, or browser-visible variables.

## Safe release gates

1. Apply the seven additive migrations to a disposable Supabase project and verify Auth, RLS, PostgREST, service-role RPC behavior and the Deriv account-list/DEMO-only selection endpoints.
2. Verify the new DEMO API routes and portfolio permission controls in a browser against that disposable project.
3. Set Production Supabase and `CRON_SECRET` environment variables in Vercel.
4. Create a preview deployment and verify public market data, virtual open/mark/partial-close/full-close, multi-position risk limits, manual permission revocation, portfolio giveback and worker lease behavior.
5. Promote/deploy only after explicit production approval.
6. Configure the single Supabase Cron job, verify successful `cron.job_run_details` and `net._http_response` entries, and confirm fresh worker heartbeat timestamps before enabling member DEMO automation.
7. Keep REAL execution disabled until secure Deriv/MT5 execution adapters, subscription enforcement, account-level risk controls, broker-native protective stops, live manual-position permission gates and independent end-to-end tests are complete.

## Product safety

- DEMO is free and uses virtual balances and virtual orders. Displayed prices are live only when backed by a verified market-data feed and must show source/timestamp/delay state.
- REAL subscription payment only grants eligibility to proceed through broker verification, risk acknowledgements and explicit authorization; it never starts live trading.
- No profitability, win-rate or return guarantee is made.
- No production Supabase change, PR merge or Vercel deployment is authorized by this branch work.


## 2026-11-20 Deriv account-selection hardening
- Added authenticated `GET /api/deriv/accounts` and `POST /api/deriv/select-account` endpoints for the account picker already present in the dashboard.
- The OAuth callback now persists sanitized active DEMO/REAL account metadata, token type, requested scopes and connection time; encrypted access tokens remain server-only.
- A single DEMO account may be preselected only when unambiguous. Multiple DEMO accounts require explicit member selection. The selection endpoint rejects REAL accounts and never changes `real_account_id`.
- Added additive migration `202611200005_deriv_verified_account_selection.sql` and disposable PostgreSQL integration coverage.
- REAL subscription status now requires a valid active time window: `starts_at <= now < ends_at`; missing, malformed, inverted or future-start dates fail closed. Payment and subscription eligibility still return `realExecutionAuthorized: false`.
- The REAL portfolio adapter now also requires the server-side `REAL_EXECUTION_ENABLED=true` release switch in addition to an `AUTHORIZED` record and all approval timestamps; unset/false keeps REAL actions blocked even if a database row is misconfigured.
- Local Node 22 checks for the targeted Deriv account-selection, subscription-window and REAL release-gate tests passed (13/13). This is not a substitute for the full GitHub Actions suite or disposable Supabase Auth/PostgREST/RLS verification.
- Integration status: GitHub still marks PR #3 as draft and not mergeable. The upgrade branch is more than 500 commits ahead of `main`, while `main` contains 39 commits not yet reconciled into this branch. Review and reconcile those main-only changes before any merge; do not force-merge or deploy.
- The branch remains unmerged and undeployed. The newest changes still need a confirmed CI run and disposable Supabase Auth/PostgREST/RLS verification. No live broker orders are authorized.
