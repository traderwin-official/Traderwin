# DEMO worker scheduling

Use **Supabase Cron + pg_net + Vault** as the only scheduler for the DEMO worker. Do not configure a parallel Vercel Cron job.

The worker is hosted at `POST|GET /api/cron/demo-auto-worker` on the Vercel production deployment. It is protected by a server-side `CRON_SECRET` of at least 32 characters. Supabase Cron invokes it once per minute and sends the secret in the Authorization header.

## Required setup

1. Review and validate the additive DEMO migrations in a disposable Supabase project first:
   - `202611200001_demo_paper_ledger_v2.sql`
   - `202611200002_portfolio_protection_state_v2.sql`
   - `202611200003_demo_multi_position_v3.sql`
   - `202611200004_demo_portfolio_close_authorization.sql`
   - `202611200005_deriv_verified_account_selection.sql`
   - `202611200006_trading_instrument_approval_registry.sql`
   - `202611210001_demo_paper_daily_realization_events.sql`
2. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET` to Vercel as server-side environment variables. Never expose them to browser code.
3. Enable Supabase `pg_cron`, `pg_net`, and Vault.
4. Store the production worker URL and the same `CRON_SECRET` value in Vault using the SQL in `DEMO_WORKER_SCHEDULING.md`.
5. Create one Supabase Cron job named `young-tiger-demo-auto-worker` with schedule `* * * * *`. Use `net.http_get` to call the worker endpoint with the Vault secret in the Authorization header.
6. Verify job history in `cron.job_run_details`, HTTP responses in `net._http_response`, and recent per-session heartbeat timestamps before enabling member DEMO automation.

## Runtime safeguards

- The worker acquires a database lease before processing and releases it after the tick.
- Each tick processes a bounded number of DEMO sessions; the current limit is three.
- It obtains verified Deriv market data and rechecks the quote and emergency controls immediately before a virtual entry.
- It writes only to the isolated DEMO paper ledger. It sends no REAL broker orders.
- The combined portfolio monitor uses the USD 20 activation threshold and 20% giveback rule. Manual paper positions are included only when the member enables monitoring; automatically closing them requires a separate explicit permission.
- A stale/missing heartbeat, failed worker authorization, quote/conversion failure, missing instrument approval, or database error must be treated as automation unavailable. Do not assume the bot is running.

## Scheduling limits and deployment

Vercel Hobby Cron is not suitable for a one-minute worker schedule. Keep the Vercel deployment focused on serving the application and API route; let Supabase Cron handle recurring invocation. Vercel's static Cron configuration uses a `crons` array, but this project deliberately does not configure a Vercel Cron job.

The schedule is not active until the production Vercel route, server-side environment variables, Supabase Vault secrets, extensions and Supabase Cron job have all been configured and verified. No REAL execution is permitted by this scheduler.
