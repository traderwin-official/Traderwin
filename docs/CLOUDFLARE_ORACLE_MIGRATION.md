# Traderwin Cloudflare + Oracle Cloud migration

## Objective

Move Traderwin away from Vercel without rebuilding the product or changing its existing Supabase project. This migration is additive and must not delete, rename, or modify Supabase data, authentication users, secrets, or existing production configuration.

## Target architecture

- Cloudflare Pages: serve the static Traderwin dashboard and public pages from a dedicated build output directory. Connect GitHub to the migration branch for preview deployments first.
- Cloudflare Workers / Pages Functions: port Vercel-style API handlers to the Fetch API request/response model. Keep privileged credentials in server-side Worker secrets.
- Oracle Cloud VM: later host a supervised Node.js service for long-running, event-driven bot orchestration and broker streaming adapters. It is not a substitute for implementing and testing Deriv/MT5 broker APIs.
- Supabase: retain the current project, Auth, Postgres tables, RLS, RPC functions, Vault, and existing user records. Update endpoint URLs/secrets only when a separately tested migration requires it.

## Important compatibility findings

- The repository is an ES module Node project with Node >=22 and @supabase/supabase-js.
- Existing API handlers use the Vercel (req, res) interface, including req.method, req.headers, req.body, req.query, res.status(), res.json(), res.redirect() and res.setHeader(). They are not directly compatible with Cloudflare Pages Functions.
- The current DEMO worker is a Vercel API handler and is invoked by Supabase Cron once per minute. Its documented behavior is DEMO paper trading only; it sends no broker orders.
- Cloudflare Pages supports GitHub-connected builds and Pages Functions, but deployment output must be a dedicated static directory. Do not set the output directory to the repository root: that could publish source code, SQL migrations, docs, and server files.
- The Worker runtime needs an explicitly chosen compatibility date and compatibility flags; Node-specific imports must be reviewed and tested before porting.

## Migration phases

### Phase 0 — protect current production

1. Keep the current Vercel project and domain unchanged during migration.
2. Work only on migration/cloudflare-oracle until preview tests pass.
3. Do not merge existing payment/trading PRs, change Supabase migrations, rotate secrets, or disable Vercel as part of this scaffold.
4. Take a Supabase backup/export before any future database change. No database change is required just to move hosting.

### Phase 1 — Cloudflare static preview

1. Inventory every public HTML page, image, stylesheet, script, font, and download referenced by the dashboard.
2. Add a build script that copies only public assets to dist/; never copy api/, lib/, supabase/, docs/, tests, or secret/config files into the public output.
3. Configure Pages Git integration to build the migration branch with Node 22 and publish dist.
4. Test login UI, navigation, responsive layout, chart widgets, and all static links on a Cloudflare preview URL.
5. Do not switch the production domain yet.

### Phase 2 — Cloudflare API compatibility

1. Port each required Vercel endpoint into functions/api/** using Fetch API handlers and context.env bindings.
2. Preserve authentication checks, ownership checks, RLS assumptions, idempotency, webhook verification, no-store headers, and safe error handling.
3. Keep Supabase service-role credentials, Deriv OAuth secrets, token encryption keys, Flutterwave credentials, and cron secrets as Worker secrets only.
4. Port and test Deriv OAuth start/callback, Flutterwave checkout/verification/webhook, M-Pesa callbacks, and the DEMO worker independently.
5. Update the Supabase Cron Vault endpoint only after the Cloudflare worker endpoint is deployed and verified. Do not leave cron pointed at an untested endpoint.

### Phase 3 — Oracle persistent service

1. Create an Oracle Cloud account and confirm Always Free capacity in the chosen home region. Availability is not guaranteed.
2. Provision only an Always Free-eligible Ubuntu/Oracle Linux VM; set strict budgets/quotas and verify the instance shape is within the current allowance before creating it.
3. Deploy a minimal health-checked Node.js service under a non-root user with systemd, firewall restrictions, automatic security updates, logs, and restart policy.
4. Add broker streaming adapters only after secure credential storage, reconnect logic, rate limiting, duplicate-order prevention, order acknowledgements, risk limits, and kill-switch tests are complete.
5. Do not enable REAL trading as part of the hosting migration.

## Secrets and environment mapping

Configure values through Cloudflare dashboard secrets or Oracle VM secret management; never commit values:

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- DERIV_CLIENT_ID
- DERIV_REDIRECT_URI
- DERIV_OAUTH_SECRET
- TOKEN_ENCRYPTION_KEY
- CRON_SECRET
- FLW_SECRET_KEY
- FLW_SECRET_HASH
- FLW_REDIRECT_URL
- PUBLIC_APP_URL

Only add variables to the runtime that actually needs them. Browser-visible variables must never contain privileged secrets.

## Acceptance checks before production cutover

- Cloudflare preview builds successfully from GitHub.
- All public pages and static assets load without exposing repository files.
- Supabase sign-in, sign-out, session refresh, and user-owned reads work against the unchanged Supabase project.
- Each migrated API route passes positive, negative, unauthorized, malformed-input, and duplicate-request tests.
- Flutterwave and M-Pesa callbacks verify payment server-side and fulfill an order exactly once.
- Deriv OAuth state/PKCE checks and encrypted token storage work.
- DEMO worker reports a fresh heartbeat and remains DEMO-only; no REAL broker orders are sent.
- Oracle service survives restart and temporary network/broker outages without duplicate orders.
- Production domain and Supabase Cron are changed only after explicit owner approval and a tested rollback plan.

## Current status

- Migration branch created from feature/unified-mpesa-services.
- Supabase is to remain unchanged.
- Static asset inventory, Cloudflare build output, Pages Functions port, Oracle VM provisioning, and production cutover remain pending.
