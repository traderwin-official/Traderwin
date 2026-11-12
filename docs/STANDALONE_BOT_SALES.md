# Standalone Bot Shop and Licensing

## Customer journey
- `/bot-shop.html` is public. Buyers do not create a Traderwin member account.
- Public catalog is served by `GET /api/bot-shop`; purchase requests use `POST /api/bot-shop`.
- Orders are created as `PENDING_PAYMENT`. Current flow is manual M-Pesa Paybill/Till confirmation; do not claim automated Daraja checkout.
- Admin verifies the transaction independently and calls `POST /api/admin/bot-license-fulfill` with `x-traderwin-admin-token`, orderId and paymentReference.
- The raw license key is returned once only. Send it securely to the buyer. Database stores SHA-256 hash only.
- Customer activates/verifies through `POST /api/bot-license/activate` using licenseKey, MT5 login, broker server and action ACTIVATE/VERIFY.
- First activation binds the license to one MT5 login + server. Transfer requires a separately reviewed support process; no self-service reset is provided.
- LIFETIME has no expiry. MONTHLY is currently 30 days from fulfillment; renewal workflow is not implemented yet.

## Required setup
1. Apply `202611120017_standalone_bot_sales.sql` after reviewing current schema.
2. Set Vercel server-side env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRADERWIN_LICENSE_ADMIN_TOKEN`, and either `TRADERWIN_MPESA_PAYBILL` or `TRADERWIN_MPESA_TILL`; optionally `TRADERWIN_MPESA_ACCOUNT_NAME`.
3. Update product prices and publish only products that are actually tested and ready. Example SQL (replace the amounts before running):
   ```sql
   update public.bot_products
   set price_kes = 15000, active = true, updated_at = now()
   where product_code = 'MT5_GOLD_LIFETIME';
   ```
   The amount above is an example only, not a Traderwin pricing recommendation. Keep products inactive until actual price, EA file, support terms and risk disclosure are approved.
4. Test order creation, manual M-Pesa verification, one-time key delivery, first activation, same-account verification, different-account rejection, expiry and suspension.
5. Configure a real customer support email/contact and email delivery before public launch. This initial implementation does not send email automatically.

## Important limitations
- This adds shop/order/license infrastructure; it does not create or compile the actual MT5 `.ex5` Expert Advisor.
- License activation is a separate online check; the EA must later implement the matching HTTPS verification protocol before it can enforce licenses.
- The API binds an account identifier but does not authenticate the MT5 broker account or verify ownership with the broker.
- No M-Pesa Daraja STK integration is included for anonymous standalone purchases. Payment is manually confirmed by an authorized admin.
- Do not publish or activate a product until the real bot has been compiled, tested on broker demo accounts, reviewed for security and delivered securely.
- Never request an MT5 master password. Never store raw license keys. Protect admin token as a Vercel server-only secret.
- Monthly renewal, refunds, automated email delivery, license transfer workflow, product download hosting and download access controls remain future work.
