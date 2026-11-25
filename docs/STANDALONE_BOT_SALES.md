# TIGER SCHEME AI BOT — Standalone Sales

## Customer journey
- Public storefront: `/bot-shop.html`. A buyer does not need a Traderwin member account.
- MT5 is the primary standalone product; Deriv listings remain inactive until their product is built and tested.
- Buyer enters name, email and Kenyan M-Pesa phone, selects a published package, and receives an STK Push prompt.
- The customer enters their M-Pesa PIN. The browser only displays progress; it cannot mark an order paid.
- Safaricom sends the STK callback to `/api/payments/mpesa/bot-shop-callback`.
- The server checks the callback, matches checkout ID, amount and phone to the pending order, and queries Daraja for the checkout result.
- A database RPC atomically records the receipt, marks the order fulfilled, creates a license hash and stores an encrypted one-time email-delivery payload. Duplicate callbacks cannot issue a second license.
- A Resend email sends the raw license key to the buyer. The raw key is encrypted in a retry outbox until delivery succeeds, then the encrypted payload is cleared.
- `/api/cron/bot-license-delivery` retries pending email deliveries. Configure a Supabase Cron/pg_net job to POST this endpoint every 5 minutes with `Authorization: Bearer <CRON_SECRET>`.
- The private `/admin-bot-sales.html` page is read-only and shows order, M-Pesa receipt and email-delivery status.

## Required Supabase migrations
Apply in order, after reviewing the project schema:
1. `202611120017_standalone_bot_sales.sql`
2. `202611120018_bot_auto_mpesa_fulfillment.sql`

Migration 018 adds Daraja checkout identifiers, payment verification fields, an encrypted delivery outbox, product naming and the atomic `fulfill_standalone_bot_order` database function.

## Vercel server-side environment variables
Set these only in Vercel project Environment Variables. Never place them in browser code or send secrets in chat.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DARAJA_ENV`: `sandbox` for testing; `production` only after Safaricom approval.
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`
- `DARAJA_SHORTCODE`
- `DARAJA_PASSKEY`
- `DARAJA_CALLBACK_URL`: exact HTTPS URL ending `/api/payments/mpesa/bot-shop-callback`.
- `BOT_LICENSE_ENCRYPTION_KEY`: 64 hexadecimal characters (32 random bytes). Generate securely; do not reuse a password.
- `RESEND_API_KEY`
- `BOT_LICENSE_FROM_EMAIL`: a sender address/domain verified with Resend.
- `CRON_SECRET`: a long random secret used by the scheduled retry endpoint.
- `TRADERWIN_LICENSE_ADMIN_TOKEN`: separate long random secret for the private sales monitor.

The existing storefront creates STK Push requests using these `DARAJA_*` names. Confirm shortcode type, transaction type and Daraja production approval with Safaricom before switching to production.

## M-Pesa payment method
- STK Push is the first automated route: the buyer approves the payment on their phone and Daraja sends a checkout callback.
- Direct customer-initiated Paybill/Till payments need a separate C2B confirmation callback registered with Safaricom. Do not treat an SMS, screenshot or a typed receipt number as proof of payment.
- Callback processing is idempotent. The receipt number is unique, amount and payer phone are matched, and the STK checkout is queried with Daraja before license issuance.
- If any verification is inconclusive, the order is moved to `PAYMENT_REVIEW`; no license is issued automatically until it is reconciled.

## Product and license rules
- MT5 product names are `TIGER SCHEME AI BOT — MT5 Lifetime` and `TIGER SCHEME AI BOT — MT5 Monthly`.
- Lifetime licenses have no expiry. Monthly licenses currently run for 30 days; renewal/extension workflow still needs implementation.
- First MT5 activation binds to the customer's MT5 login and broker server. The activation API must be embedded in the compiled EA before licenses can be technically enforced.
- Do not activate a product or publish a price until the compiled `.ex5` bot, download delivery, product support terms and demo-account testing are complete.
- Never request or store an MT5 master password. Never publish the raw license key or the encryption key.
- The current license verification API records an MT5 login/server binding but does not authenticate broker ownership by itself.

## Not yet production-ready
- Safaricom Daraja credentials, shortcode, callback registration and production approval have not been supplied/configured.
- Resend account, verified sender domain and delivery credentials have not been configured.
- Supabase migrations have not been confirmed as applied.
- Scheduled retry job has not been configured.
- The actual compiled TIGER SCHEME AI BOT `.ex5` and its in-EA license verification call have not yet been produced.
- No live customer payments should be accepted until sandbox tests and a small controlled production verification are completed.
