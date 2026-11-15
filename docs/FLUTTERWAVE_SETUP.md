# Flutterwave setup for Tiger Scheme

## What this integration does

Tiger Scheme creates a hosted Flutterwave checkout from Cloudflare Pages Functions (`functions/api/payments/flutterwave/create.js` and `complete.js`). It calculates the amount from the trusted service catalogue, creates a pending payment order, and redirects the customer to Flutterwave. The return route and webhook both verify the transaction with Flutterwave before calling the existing atomic service-fulfilment RPC. A browser redirect or webhook body alone never grants access.

The first release charges in **KES**. International cardholders may see a conversion applied by their card issuer. USD settlement is not enabled by this integration.

## Cloudflare Pages environment variables

Add these under the Tiger Scheme Pages project → Settings → Variables and Secrets. Use encrypted secrets for private keys:

- `FLW_SECRET_KEY`: Flutterwave **test** secret key for sandbox testing; use the live key only after merchant approval.
- `FLW_SECRET_HASH`: a long random webhook secret hash. Set the same value in Flutterwave Dashboard → Settings → Webhooks.
- `FLW_REDIRECT_URL`: absolute HTTPS URL ending in `/api/payments/flutterwave/complete` on the Tiger Scheme Cloudflare Pages preview/custom domain.
- `PUBLIC_APP_URL`: the matching Tiger Scheme Cloudflare Pages preview/custom domain.
- Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are also required.

Never put the secret key or webhook hash in browser code, GitHub, screenshots, or chat. Configure test credentials only in the Cloudflare Preview environment first. Do not add production credentials until the preview is tested.

## Flutterwave dashboard

1. Create/verify the Traderwin merchant account and complete the requested business KYC.
2. Switch to Test mode and copy the test Secret Key from Settings → API Keys.
3. Configure a webhook URL using the public Tiger Scheme Cloudflare Pages preview URL: `/api/payments/flutterwave/complete`.
4. Set its Secret Hash to exactly the value stored in `FLW_SECRET_HASH`.
5. Enable successful charge events and save.
6. Test cards and supported payment methods in sandbox. Do not use live credentials until tests and merchant approval are complete.

## Supabase

Review and apply migrations in order. This PR adds `202611130023_flutterwave_checkout.sql`; it does not apply it automatically. It permits FLUTTERWAVE as a payment method and stores unique server-generated references and verified transaction IDs.

## API

Authenticated browser request:

`POST /api/payments/flutterwave/create`

Body: `{"serviceCode":"REAL_TRADING"}` (or another active service code).

Use the returned `checkoutUrl` for a top-level redirect. Do not trust a price sent by the browser.

Webhook and redirect verification endpoint:

`POST/GET /api/payments/flutterwave/complete`

The endpoint checks the webhook `verif-hash`, then independently calls Flutterwave's transaction verification API and compares transaction ID, tx_ref, successful status, KES currency, and amount before service fulfillment. Fulfillment is idempotent through the existing database RPC.

## Current limitations

- Checkout amount is KES only. A card issuer may convert for an overseas cardholder; the customer must see the KES total before paying.
- No recurring automatic card charge is configured; subscription renewals remain manual.
- The website now offers M-Pesa and Flutterwave as selectable payment methods. The Flutterwave button calls the authenticated server route and redirects to hosted checkout.
- The Supabase migration `202611130023_flutterwave_checkout.sql` has not been applied.
- The Cloudflare Pages project has not yet been connected or deployed; therefore the final webhook URL is not yet known.
- No merchant KYC, credentials, sandbox payment, or live payment has been completed.
- The existing Vercel routes remain in place for rollback and are not replaced by this preview implementation.
