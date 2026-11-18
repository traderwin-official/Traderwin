# Tiger Scheme bot-license Pages Function

The existing Vercel `POST /api/bot-license/activate` endpoint is ported to Cloudflare Pages as `functions/api/bot-license/activate.js`.

## Runtime bindings

Configure these only in the **preview** environment after the Tiger Scheme Pages project has been verified:

- `SUPABASE_URL`: the existing Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the existing Supabase service-role secret. Store it as a Cloudflare secret, never as a plain variable.
- `APP_RATE_LIMITER`: a Cloudflare service binding to the existing `tiger-scheme-rate-limiter` Worker.
- `APP_RATE_LIMITER_TOKEN`: the same high-entropy token configured as `MPESA_RATE_LIMITER_TOKEN` on that Worker. Set it as a Pages secret; do not put it in source control or send it in chat.

The rate-limiter Worker must already have its Durable Object binding and token configured. Until the service binding and token are available, license verification deliberately returns HTTP 503 rather than accepting unprotected activation attempts.

## Request and safety behaviour

- Accepts only POST JSON with a license key, MT5 login number, MT5 server and `ACTIVATE` or `VERIFY` action.
- The license key is hashed with SHA-256 before database lookup; the raw key is never logged or sent to the rate-limiter service.
- Applies an IP limit before parsing the key, then a second per-license-key limit.
- Requires an existing `bot_licenses` row with `status = ACTIVE`; payment fulfillment remains the only process that issues and activates a license record.
- `ACTIVATE` binds an unbound license using a compare-and-set update. A retry for the same MT5 login/server is idempotent; a different account cannot take over the binding.
- `VERIFY` never activates an unbound license.
- Expired licenses are marked EXPIRED and rejected.
- The route does not ask for an MT5 master password, broker token or account password, and it does not connect to MT5 or place trades.

## Supabase dependency

The route uses the existing `bot_licenses` table from `202611120017_standalone_bot_sales.sql`. No new SQL migration is introduced or applied by this port. Confirm that the migration is already present in the existing project before enabling the endpoint.

## Preview verification checklist

1. Confirm the Pages project is a Pages project and the feature branch is preview-only.
2. Deploy the existing rate-limiter Worker to a non-production test environment after owner approval.
3. Add the four preview bindings/secrets listed above using Cloudflare's dashboard.
4. Test missing/invalid/expired keys, first activation, same-account retry, wrong-account rebind, IP rate limiting and per-key rate limiting.
5. Verify the database stores only the SHA-256 key hash and never receives the raw key.
6. Confirm the route never returns the license key or any service-role credential.
7. Do not enable public license activation until the preview tests pass.

No Supabase data, users, credentials or production hosting are changed by adding this Pages Function.
