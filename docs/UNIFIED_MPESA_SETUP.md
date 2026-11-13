# Unified Tiger Scheme M-Pesa Setup

## One receiving account

Traderwin uses one Safaricom Daraja merchant shortcode for all payment types:
- Traderwin REAL Trading, Advanced Bot, Premium Signals and Education services
- Monthly and lifetime standalone bot purchases

The money settles to the Safaricom business account attached to the configured Paybill/Till shortcode. Supabase records payment orders and entitlements; it does not receive or hold the money.

Use a business Paybill/Till owned or authorized by the Traderwin business. Do not use a personal shortcode unless Safaricom has approved that setup for the business.


## Important: the supplied 522522 number is not a Traderwin Daraja merchant shortcode

Safaricom's published mobile-banking paybill list identifies **522522 as KCB Bank's M-PESA-to-bank paybill**. The account number is used to deposit into a KCB bank account. It is not evidence of a Traderwin-owned Safaricom merchant Paybill, and it must not be placed in `DARAJA_SHORTCODE` or treated as an STK Push merchant shortcode. Confirm the KCB account ownership and intended settlement arrangement before publishing any manual bank-deposit instructions. KCB bank deposits do not automatically provide Traderwin's Daraja merchant callback; reconciliation would need a supported bank integration or controlled manual verification.

## International checkout status

Tiger Scheme now has a Cloudflare Pages Flutterwave checkout implementation in `functions/api/payments/flutterwave/`. It is code-complete only at the current integration boundary: it still requires Cloudflare environment secrets, the Supabase migration `202611130023_flutterwave_checkout.sql`, a verified merchant account, and sandbox end-to-end testing. Do not describe it as live or production-ready. The M-Pesa member checkout and unified Daraja callback are still in the original Vercel API routes; their Cloudflare Pages Functions migration and sandbox verification remain outstanding.

Regional pricing must be shown clearly before payment. Any country-based price difference must be calculated from the verified billing country supplied by the payment provider, recorded on the order, and displayed in the checkout total and currency. Do not infer a customer's region only from their IP address or silently apply a surcharge.

## Current Vercel configuration (existing deployment)

Configure these as server-side Vercel environment variables only:

- `DARAJA_ENV`: `sandbox` for testing; `production` only after Safaricom production approval
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`
- `DARAJA_SHORTCODE`: the one receiving Paybill/Till shortcode
- `DARAJA_PASSKEY`
- `DARAJA_CALLBACK_URL`: `https://traderwin-naq2.vercel.app/api/payments/mpesa/bot-shop-callback`
- `DARAJA_TRANSACTION_TYPE`: `CustomerPayBillOnline` for a Paybill; use `CustomerBuyGoodsOnline` only for the matching Till configuration
- Existing Supabase variables: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

Never put these credentials in browser code, GitHub commits, screenshots or chat messages. The same Daraja credentials and shortcode are used by member checkout and standalone bot checkout.

## Checkout and callback behaviour

- Members sign up and log in for free.
- DEMO mode remains free.
- A signed-in member requests an STK Push from the service checkout.
- A standalone bot customer requests an STK Push from the public bot shop without a Traderwin member account.
- Both checkouts call Daraja using the same merchant credentials and callback URL.
- The shared callback identifies the pending order by its Daraja CheckoutRequestID, checks amount and payer phone, queries Daraja, then invokes the appropriate atomic Supabase fulfillment routine.
- A member service payment activates the matching service entitlement. A standalone bot payment issues a license only after successful verification and queues its delivery email.
- Duplicate callbacks cannot grant a second entitlement/license for the same order.
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

## Supabase migration

After reviewing the existing schema and confirming all prerequisite migrations are installed, the migration file in this branch is:
`supabase/migrations/202611130022_unified_mpesa_services.sql`

Do not apply it until the preceding Traderwin migrations have been reviewed and applied in order. This migration adds the unified service entitlement ledger, service payment fulfillment RPC, pricing and premium signal/AI access policy.

## Sandbox test checklist

1. Keep `DARAJA_ENV=sandbox`.
2. Configure sandbox shortcode, consumer key/secret, passkey and callback URL.
3. Confirm the callback URL is publicly reachable over HTTPS.
4. Test one member purchase for each paid service.
5. Test one standalone bot order after its product is deliberately activated for sandbox testing.
6. Verify successful, cancelled, duplicate, mismatched amount and mismatched phone callbacks.
7. Confirm service entitlements activate only after Daraja verification.
8. Confirm failed/review payments do not activate access or issue licenses.
9. Switch to production only after Safaricom has approved the merchant and production credentials, and after end-to-end sandbox tests pass.

## Still required before accepting live payments

- Safaricom Daraja merchant credentials, shortcode/passkey and production approval must be supplied by the owner and configured in Vercel.
- The new Supabase migration must be applied in order.
- Test the unified callback against Safaricom sandbox.
- Set the actual standalone bot packages active only after the compiled EA, download delivery, embedded license verification and support terms are complete.
- Confirm service gates in the dashboard/API for every paid feature before publicly selling it. Premium signal/AI table access is subscription-gated by the migration; other feature-specific delivery still needs integration and testing.
- Do not claim live payments are working until the real merchant account has passed a controlled verification.

