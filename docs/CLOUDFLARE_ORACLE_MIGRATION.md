# Cloudflare Pages and Oracle Cloud migration

## Scope and safeguards

This is a staged migration, not a one-click host swap. Preserve the current Supabase project and its data. Keep the current Vercel deployment available until the replacement passes end-to-end tests. Do not change DNS, delete Vercel, apply database migrations, or enable real-money trading as part of this preparation.

## Stage 1: static frontend

- Cloudflare Pages project name: \`tiger-scheme\`.
- Git repository: \`traderwin-official/Traderwin\` (repository slug is deliberately unchanged to avoid breaking existing GitHub links).
- Migration branch: \`feature/tiger-scheme-cloudflare\`.
- Build command: \`npm run build\`.
- Output directory: \`dist\`.
- Node.js: 22.
- The build copies only root HTML pages and approved static folders. It does not publish server source, SQL, tests, secrets or the \`api/\` directory.

## Stage 2: API conversion

The following Cloudflare Pages Function groups are now present on the migration branch:

- Flutterwave member checkout and verified completion callback.
- Unified M-Pesa member checkout, member payment status, shared Daraja callback, public standalone bot shop and standalone order status.

The original Vercel handlers remain unchanged as rollback references. These Functions have passed repository CI syntax/build/unit checks, but they are not deployed and have not passed live-provider sandbox or end-to-end Supabase verification.

The M-Pesa group fails closed until a separate Durable Object rate-limiter Worker is deployed and bound to Pages as \`MPESA_RATE_LIMITER\`. The same high-entropy \`MPESA_RATE_LIMITER_TOKEN\` must be configured as an encrypted secret on both sides. Preview-only Daraja sandbox and Supabase secrets must be configured in Cloudflare; never copy them into source control or chat.

Remaining API groups include Deriv OAuth/account management, market data, bot configuration, license verification and admin/operations routes. Inventory each route and port it separately, preserving authorization, ownership, idempotency and audit behavior.

Required end-to-end tests:
- Supabase signup, login, logout, session refresh and account-mode onboarding.
- Authenticated user ownership and Row Level Security.
- Flutterwave checkout creation, signed webhook validation, transaction verification, idempotent fulfillment and refund/failure paths.
- Daraja/M-Pesa callbacks, duplicate handling, reconciliation and license email delivery.
- Deriv public market data, OAuth scopes and candle freshness.
- Bot settings, emergency stop, DEMO open/close atomic RPCs and worker heartbeat.
- Rate limiting, abuse controls, logs with secrets redacted and failure recovery.

Set secrets in Cloudflare Pages project settings, never in source control or browser JavaScript. Keep only genuinely public Supabase URL/publishable key in client configuration.

## Stage 3: scheduled DEMO worker

Replace Vercel Cron with a Cloudflare Cron Trigger only after porting the worker to a Cloudflare Worker entry point. Verify schedule cadence, per-tick workload, Supabase connection behavior, duplicate prevention, retry safety, stale quote handling and emergency-stop behavior. Current one-minute DEMO processing is not tick-by-tick scalping and does not execute REAL broker orders.

## Stage 4: Oracle Cloud persistent service

Prepare Oracle Cloud persistent bot hosting only after the event-driven bot service is implemented and tested. Provision a VM only after the owner reviews availability, cost and account requirements and explicitly approves it. Use a dedicated non-root service account, systemd restart policy, firewall allowlist, TLS, secret storage, monitoring, backups and resource alarms. Keep broker credentials encrypted and never request or store a user's MT5 master password. A secure MT5 bridge generally needs a separately operated terminal/EA or approved broker integration; a generic VM does not create broker connectivity by itself.

## Go-live gate

Do not change the public domain until every required route is ported, sandbox payments pass, DEMO worker passes repeated soak tests, Supabase RLS is reviewed, security headers are set, and rollback is documented. Keep REAL execution disabled until a separate broker adapter and safety review are complete.
