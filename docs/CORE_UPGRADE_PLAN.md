# Traderwin core upgrade

This branch is a protected upgrade workspace. The live `main` branch is not changed.

## Current verified baseline

- Supabase email/password authentication exists.
- The dashboard contains TradingView chart widgets and a risk calculator.
- Bot settings are currently saved with `account_mode = DEMO` and `enabled = false`.
- The current repository does not contain an MT5 execution service, a running bot worker, an AI market-data pipeline, or a completed M-Pesa checkout/callback flow.
- Deriv OAuth routes exist, but the callback currently stores a null Deriv account ID and does not establish a tested order-execution workflow.
- TradingView chart prices are indicative and must not be represented as broker execution prices.

## Foundation added on this branch

- An additive Supabase migration for per-user DEMO/REAL account-mode preferences and risk limits.
- An immutable-to-browser live-trading gate: authenticated browser clients cannot set `real_trading_enabled`.
- A server-side audit trail for account-mode changes.
- A correctly located `lib/encryption.js` helper, which also resolves the import path used by the legacy `api/callback.js` route.

## Required setup

1. Review and run `supabase/migrations/202611120001_trader_profiles.sql` in the Traderwin Supabase SQL Editor.
2. Keep `SUPABASE_SERVICE_ROLE_KEY`, `DERIV_OAUTH_SECRET`, and `TOKEN_ENCRYPTION_KEY` only in Vercel server-side environment variables. Never put them in HTML or commit them.
3. Confirm the Deriv OAuth redirect URI exactly matches the callback URL configured with Deriv.
4. Do not enable live trading until broker identity/account verification, token encryption/decryption, order sizing, stop-loss/daily-loss enforcement, duplicate-order protection, kill switch, audit logging and demo tests are complete.

## Upgrade sequence

1. Account onboarding and per-user mode/risk preferences.
2. Deriv account verification and a demo-only order lifecycle.
3. MT5 bridge architecture and broker-side demo verification.
4. Admin/member roles, service entitlements and M-Pesa STK Push with signed callback validation and idempotent payment records.
5. AI market analyst using licensed/reliable market data and explicitly public, legally accessible sentiment sources. Every idea must carry timestamp, source, reasoning, entry, invalidation/stop, targets and risk/reward. It must not claim access to private trader positions or guarantee results.
6. Independent tests, security review, staged rollout and only then a separately approved live-trading capability.

## Important distinction

Selecting REAL mode is a preference and acknowledgement flow only. It does not connect a broker, activate a bot, or place an order. Live execution must remain disabled until a separate trusted server-side approval and safety workflow is implemented and tested.
