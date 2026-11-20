# Deriv OAuth on Cloudflare Pages

## Routes ported

The migration branch contains these Pages Functions:

- `POST /api/deriv/start`: requires a Supabase bearer session, verifies the user with the existing Supabase project, then creates a short-lived signed OAuth state cookie and PKCE challenge.
- `GET /api/deriv/callback`: validates the signed state cookie, exchanges the authorization code, verifies the returned account list, encrypts the access token with AES-256-GCM and saves the connection for the user encoded in the signed state.
- `GET /api/deriv/status`: requires a Supabase bearer session and returns only the authenticated user's account identifiers and token expiry metadata.
- `POST /api/deriv/disconnect`: requires a Supabase bearer session and deletes only that user's `deriv_connections` row.

The Vercel handlers remain unchanged as rollback references. These routes do not submit, open, modify or close broker orders. REAL execution remains outside this migration.

## Cloudflare Pages environment

Configure the following only in the Tiger Scheme Pages project's encrypted environment settings. Use preview values for preview deployments; do not place secrets in GitHub source, browser code, screenshots or chat.

- `SUPABASE_URL`: URL of the existing Supabase project used by Tiger Scheme.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role key for that same project. Keep server-side only.
- `DERIV_CLIENT_ID`: Deriv OAuth application client ID.
- `DERIV_REDIRECT_URI`: exact callback URL for this Cloudflare Pages preview, ending in `/api/deriv/callback`.
- `DERIV_OAUTH_SECRET`: high-entropy secret used to sign the short-lived OAuth state cookie.
- `TOKEN_ENCRYPTION_KEY`: 32-byte key encoded as exactly 64 hexadecimal characters for AES-256-GCM token encryption.

Register the exact preview callback URL in the Deriv application settings before testing OAuth. Do not guess the Pages preview hostname: copy the exact preview URL shown by Cloudflare, append `/api/deriv/callback`, and use that exact value in both places.

## Permission and safety notes

The source Vercel start route currently requests the Deriv `trade` OAuth scope, so this port preserves that behavior. Granting OAuth permission is not the same as placing an order; these four routes do not send trades. Review the requested scope before an account owner authorizes the preview connection. Do not enable REAL execution as part of this migration.

The callback currently requires an active DEMO account to be returned before saving the connection; it records the first eligible DEMO account and optionally the first eligible REAL account. The status endpoint reports the connection as active only while a DEMO account is recorded and the access token has not expired.

The disconnect endpoint removes the local encrypted connection row; it does not claim to revoke the token at Deriv. Provider-side revocation and account re-authorization must be handled separately if required.

## Preview verification checklist

1. Confirm the Pages preview URL and register its exact callback URL with the Deriv OAuth application.
2. Configure the six encrypted environment values above in the preview environment only.
3. Confirm the Supabase URL and service-role key refer to the same existing project; do not run SQL migrations for this test.
4. Sign in as a test user, start OAuth, cancel once, and confirm the UI reports cancellation without saving a connection.
5. Authorize a DEMO account and verify the encrypted token is stored against only that authenticated user.
6. Confirm the status endpoint never returns the encrypted token or access token.
7. Confirm disconnect deletes only the signed-in user's connection.
8. Confirm no broker order is submitted and REAL execution remains disabled.

Do not run the Cloudflare preview deployment workflow until the owner has configured and approved the required Cloudflare/GitHub preview credentials and Deriv callback registration.


## Read-only Deriv active-symbol discovery

The migration branch also provides `GET /api/deriv/active-symbols` as a public, read-only Pages Function. It requests Deriv's public `active_symbols: brief` catalogue over an outbound WebSocket, validates the provider response, removes malformed/duplicate symbols, and returns provider metadata. It does not activate a symbol, change the platform's approved instrument list, create a trade, or submit a broker order.

The endpoint is limited to 20 requests per Cloudflare client IP per 60-second window. It requires the existing `APP_RATE_LIMITER` service binding and `APP_RATE_LIMITER_TOKEN` secret; if either is missing or the limiter is unavailable, the route fails closed with HTTP 503. Excess requests receive HTTP 429 and `Retry-After`. Successful catalogue responses carry short public cache headers; errors are not cached.

Cloudflare Workers supports outbound `new WebSocket(url)` connections (see the [Workers WebSockets documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/)). The preview still needs a real provider connection test after the Pages project and preview-only rate-limiter binding are configured. Do not run the preview deployment workflow until the owner has approved and configured those preview resources.


## Verified account list and DEMO account picker

The Cloudflare Pages Functions also provide:

- `GET /api/deriv/accounts` — returns the authenticated user's sanitized, active Deriv account metadata and the currently selected account. Access tokens are never returned.
- `POST /api/deriv/select-account` — accepts only an active, provider-verified DEMO account ID belonging to that user's saved Deriv connection. The update is scoped to the authenticated user and uses the current token-expiry value as a compare-and-set guard.

The OAuth request uses `trade account_manage` so the callback can verify the provider account list. This scope is not live-trading approval: the account picker refuses REAL account selection, returns `real_trading_enabled: false`, and these routes submit no broker orders.

The callback stores only normalized account identifiers, account types, currency/status/group metadata, token type, requested scopes and timestamps alongside the existing encrypted token. Raw provider access tokens are not copied into the account list or response.

**Database prerequisite:** `supabase/migrations/202611200005_deriv_verified_account_selection.sql` adds the `accounts`, `token_type`, `requested_scopes` and `connected_at` columns to the existing `deriv_connections` table. It has been added to the repository only; it has **not** been applied to Supabase. Do not enable these routes against a database that lacks the columns. Apply the migration only after a separate schema review and explicit owner approval.

Preview testing also requires the existing Supabase and Deriv environment variables to be configured in Cloudflare's preview environment, and the exact preview callback URL to be registered with the Deriv OAuth application. Do not put credentials in source control or chat.
