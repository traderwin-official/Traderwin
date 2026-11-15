# Tiger Scheme

Tiger Scheme is a multi-user trading research, education and risk-management platform. It is a separate product from the user's other website, Traderwin.

## Migration status

This branch prepares a staged migration from Vercel to Cloudflare Pages while preserving the existing Supabase project, authentication, database and user records.

- Frontend brand: Tiger Scheme.
- GitHub repository slug remains `traderwin-official/Traderwin` for now; renaming the repository is a separate optional GitHub operation and is not required for deployment.
- Cloudflare Pages static build output: `dist/`.
- Cloudflare Pages configuration: `wrangler.toml`.
- Build command: `npm run build`.
- Supabase remains the system of record. No database or authentication migration is required for the hosting move.
- Existing Vercel API handlers and scheduled jobs are NOT yet converted to Cloudflare Pages Functions/Workers. Do not switch production DNS or treat this static deployment as production-ready until the API compatibility checklist is complete.
- Oracle Cloud is a later stage for a persistent, event-driven bot service; it is not provisioned by this repository change.

## Build locally

```sh
npm ci
npm run build
```

The build script copies root-level HTML entry pages and approved static asset directories into `dist`. It intentionally excludes `api/`, `lib/`, `supabase/`, `docs/`, tests, environment files and repository metadata from the public web output.

## Deployment plan

1. Connect this repository and branch to Cloudflare Pages.
2. Set build command to `npm run build`, output directory to `dist`, and Node.js version to 22.
3. Configure public Supabase URL and publishable/anon key as build/runtime public configuration only. Never expose service-role keys or payment/broker secrets.
4. Port each Vercel `api/` endpoint to Cloudflare Pages Functions and test Supabase auth, Flutterwave, M-Pesa and Deriv quote flows.
5. Replace Vercel Cron with a secured Cloudflare Cron Trigger only after worker semantics, secrets, idempotency and timeout behavior are tested.
6. Provision Oracle Cloud only when the persistent bot service is ready; use outbound-only broker connections, secret management, health checks and restart supervision.
7. Test the full system on a temporary Pages URL before changing the production domain.

## Safety

DEMO uses virtual money. REAL account selection or subscription payment never authorizes live orders. No profits are guaranteed. Never commit Supabase service-role keys, broker tokens, payment credentials, private keys or encryption keys.
