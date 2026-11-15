# Unified Tiger Scheme M-Pesa Setup

## One receiving account

Tiger Scheme uses one Safaricom Daraja merchant shortcode for all payment types:
- REAL Trading, Advanced Bot, Premium Signals and Education services
- Monthly and lifetime standalone bot purchases

The money settles to the Safaricom business account attached to the configured Paybill/Till shortcode. Supabase records payment orders and entitlements; it does not receive or hold the money.

Use a business Paybill/Till owned or authorized by the business. Do not use a personal shortcode unless Safaricom has approved that setup for the business.

## Important: the supplied 522522 number is not a Tiger Scheme Daraja merchant shortcode

Safaricom's published mobile-banking paybill list identifies **522522 as KCB Bank's M-PESA-to-bank paybill**. The account number is used to deposit into a KCB bank account. It is not evidence of a Tiger Scheme-owned Safaricom merchant Paybill, and it must not be placed in \`DARAJA_SHORTCODE\` or treated as an STK Push merchant shortcode. Confirm the KCB account ownership and intended settlement arrangement before publishing any manual bank-deposit instructions. KCB bank deposits do not automatically provide Tiger Scheme's Daraja merchant callback; reconciliation would need a supported bank integration or controlled manual verification.

## Cloudflare migration status

Cloudflare Pages Functions ports for member M-Pesa checkout, payment status, the unified Daraja callback, the public bot shop and bot-shop order status are now present under \`functions/api/\` on the migration branch. The original Vercel handlers remain unchanged as rollback references. These Functions are **not deployed and not sandbox-verified**; do not advertise M-Pesa as active on Cloudflare yet.

The Pages Functions fail closed until the required rate-limiter service binding and secrets are configured. The separate Durable Object rate-limiter Worker is in \`workers/mpesa-rate-limiter/\`. It is not deployed by the static Pages build or by the preview workflow.

Flutterwave Pages Functions remain in \`functions/api/payments/flutterwave/\`. They also require Cloudflare secrets, migration \`202611130023_flutterwave_checkout.sql\`, verified merchant onboarding and sandbox end-to-end testing.

Regional pricing must be shown clearly before payment. Any country-based price difference must be calculated from the verified billing country supplied by the payment provider, recorded on the order, and displayed in the checkout total and currency. Do not infer a customer's region only from their IP address or silently apply a surcharge.

## Existing Vercel configuration (leave unchanged during preview)

The current Vercel deployment continues to use its existing server-side environment variables:

- \`DARAJA_ENV\`: \`sandbox\` for testing; \`production\` only after Safaricom production approval
- \`DARAJA_CONSUMER_KEY\`
- \`DARAJA_CONSUMER_SECRET\`
- \`DARAJA_SHORTCODE\`: the one receiving Paybill/Till shortcode
- \`DARAJA_PASSKEY\`
- \`DARAJA_CALLBACK_URL\`: the current Vercel callback URL
- \`DARAJA_TRANSACTION_TYPE\`: \`CustomerPayBillOnline\` for a Paybill; use \`CustomerBuyGoodsOnline\` only for the matching Till configuration
- Existing Supabase variables: \`SUPABASE_URL\` and \`SUPABASE_SERVICE_ROLE_KEY\`

Do not change Vercel variables while preparing the Cloudflare preview. Never put credentials in browser code, GitHub commits, screenshots or chat messages.

## Cloudflare preview-only setup

Complete this only after the Tiger Scheme Pages preview project exists and the owner has reviewed any Cloudflare plan or Durable Objects charges. Keep production DNS and the existing Vercel environment unchanged.

1. Deploy the separate rate-limiter Worker from the repository root with \`npx wrangler deploy --config workers/mpesa-rate-limiter/wrangler.toml\`.
2. Set a high-entropy secret named \`MPESA_RATE_LIMITER_TOKEN\` on that Worker. Set the **same value** as an encrypted Pages secret; never paste it into chat or commit it.
3. In the Tiger Scheme Pages project, add a **Service binding** named \`MPESA_RATE_LIMITER\` pointing to the Worker \`tiger-scheme-rate-limiter\`. Redeploy the preview after adding the binding.
4. Add preview-only secrets/variables: \`SUPABASE_URL\`, \`SUPABASE_SERVICE_ROLE_KEY\`, \`DARAJA_ENV=sandbox\`, \`DARAJA_CONSUMER_KEY\`, \`DARAJA_CONSUMER_SECRET\`, \`DARAJA_SHORTCODE\`, \`DARAJA_PASSKEY\`, \`DARAJA_TRANSACTION_TYPE\`, \`DARAJA_CALLBACK_URL\`, \`BOT_LICENSE_ENCRYPTION_KEY\`, \`RESEND_API_KEY\` and \`BOT_LICENSE_FROM_EMAIL\` as applicable. Secrets must be encrypted in Cloudflare.
5. Set \`DARAJA_CALLBACK_URL\` to the **actual HTTPS URL** of the deployed Tiger Scheme preview followed by \`/api/payments/mpesa/bot-shop-callback\`. Do not guess the preview hostname. The same unified callback handles member and standalone bot STK requests.
6. Keep the preview and production environments separate. Do not set \`DARAJA_ENV=production\` during preview.

The rate limiter applies fixed-window controls: 3 member checkouts per user per minute, 10 per IP per minute for member checkout, 3 public bot-shop checkouts per IP per minute, and 60 callback/status requests per IP per minute. If the rate-limiter binding is unavailable, payment routes return a service error instead of proceeding without protection.

Cloudflare Pages supports service bindings for Pages Functions; see the [Cloudflare Pages bindings guide](https://developers.cloudflare.com/pages/functions/bindings/).

## Checkout and callback behaviour

- Members sign up and log in for free; DEMO mode remains free.
- A signed-in member requests an STK Push from the service checkout.
- A standalone bot customer requests an STK Push from the public bot shop without a member account.
- Both checkouts use the same Daraja merchant credentials and unified callback.
- The callback identifies a pending order by Daraja CheckoutRequestID, checks amount and payer phone, queries Daraja, then invokes the appropriate atomic Supabase fulfillment routine.
- A member service payment activates the matching service entitlement. A standalone bot payment issues a license only after successful verification and queues its delivery email.
- Duplicate callbacks cannot grant a second entitlement/license for the same order because fulfillment is guarded by database row locks, unique references and unique order/license relationships.
- If verification does not match, the order is placed in payment review; no access or license is issued automatically.

## Suggested service pricing

| Service | Price |
|---|---:|
| Account registration / membership | Free |
| DEMO trading | Free |
| REAL Trading first month | USD 75 |
| REAL Trading subsequent months | USD 175/month |
| Advanced Bot subscription | KES 2,500/month |
| Premium Signals & AI Analysis | KES 1,000/month |
| Trading Education | From KES 1,500 per published course |
| Standalone MT5 Bot monthly | KES 2,500 (kept inactive pending finished bot delivery) |
| Standalone MT5 Bot lifetime | KES 12,000 (kept inactive pending finished bot delivery) |

USD subscription amounts are converted to KES using a fresh USD/KES quote at checkout; the exact KES amount is snapshotted into each payment order. Automatic recurring billing is not enabled; renewals are manual.

## Supabase migration prerequisites

No Supabase migration has been applied as part of this hosting work. Review the existing migration sequence and actual live schema before requesting approval to apply any of these:

- \`202611120017_standalone_bot_sales.sql\`: standalone bot products, orders and licenses
- \`202611120018_bot_auto_mpesa_fulfillment.sql\`: Daraja checkout references, license email outbox and atomic standalone-bot fulfillment RPC
- \`202611130022_unified_mpesa_services.sql\`: service entitlements and atomic member-service payment fulfillment RPC
- \`202611130023_flutterwave_checkout.sql\`: Flutterwave transaction references and payment-method constraints

The Cloudflare M-Pesa callback depends on the RPCs introduced by migrations 018 and 022. Do not apply migrations from this branch until all preceding migrations and the actual Supabase schema have been reviewed and the owner explicitly approves.

## Sandbox test checklist

1. Keep \`DARAJA_ENV=sandbox\`.
2. Configure the preview-only rate-limiter binding and Daraja sandbox secrets.
3. Confirm the actual preview callback URL is publicly reachable over HTTPS.
4. Test one member purchase for each paid service.
5. Test one standalone bot order only after its product is deliberately activated for sandbox testing.
6. Verify successful, cancelled, duplicate, mismatched amount and mismatched phone callbacks.
7. Confirm service entitlements activate only after Daraja verification.
8. Confirm failed/review payments do not activate access or issue licenses.
9. Verify email outbox retries and that duplicate callbacks do not send duplicate licenses.
10. Switch to production only after Safaricom has approved the merchant and production credentials, and after end-to-end sandbox tests pass.

## Still required before accepting live payments

- Safaricom Daraja merchant credentials, shortcode/passkey and production approval must be configured by the owner.
- Migrations 017, 018 and 022 must be reviewed and applied in sequence after approval.
- Deploy and test the Cloudflare rate-limiter Worker and Pages service binding.
- Test the unified callback against Safaricom sandbox.
- Configure Resend and verify the sender before promising automatic license email delivery.
- Keep standalone bot products inactive until the compiled EA, download delivery, embedded license verification and support terms are complete.
- Confirm service gates in the dashboard/API for every paid feature before publicly selling it.
- Do not claim live payments are working until the real merchant account has passed a controlled verification.
