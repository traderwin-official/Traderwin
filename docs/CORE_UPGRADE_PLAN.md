# Traderwin core upgrade

This branch is an isolated upgrade workspace. The live `main` branch is not changed.

## Current repository baseline

- Supabase email/password authentication exists.
- The dashboard contains TradingView charts and a basic risk calculator.
- Bot settings are saved with automation disabled; this is not a running bot engine.
- Deriv OAuth routes exist, but the callback stores a null Deriv account ID and no verified order-execution workflow is present.
- No MT5 execution service, AI market-data pipeline, or completed M-Pesa checkout/callback flow is present in the repository.
- TradingView chart prices are indicative, not executable broker quotes.

## Included in this foundation branch

- Per-user DEMO/REAL account-mode and risk-preference schema.
- RLS policies and an audit trail for account-mode changes.
- A server-controlled `real_trading_enabled` gate that browser clients cannot change.
- A first-login onboarding page for account mode.
- A correctly located shared AES-256-GCM token-encryption helper for the legacy callback import.

## Setup

1. Review and run `supabase/migrations/202611120001_trader_profiles.sql` in the Traderwin Supabase SQL Editor.
2. Keep `SUPABASE_SERVICE_ROLE_KEY`, `DERIV_OAUTH_SECRET`, and `TOKEN_ENCRYPTION_KEY` in Vercel server-side environment variables only. Never put them in HTML or commit them.
3. Confirm the Deriv OAuth redirect URI exactly matches the callback URL registered with Deriv.
4. Do not enable live orders until broker identity/account verification, token encryption and decryption, order sizing, stop-loss and daily-loss enforcement, duplicate-order protection, a kill switch, audit logging and demo tests are complete.

## Next implementation stages

1. Complete onboarding and per-user account preferences.
2. Verify Deriv account identity and implement a demo-only order lifecycle.
3. Build and test the MT5 bridge against a broker demo account.
4. Add admin/member roles, service entitlements, and M-Pesa STK Push with signed callback validation and idempotent payment records.
5. Add an AI market analyst using licensed market data and public, legally accessible sentiment sources. Every idea should include timestamps, sources, reasoning, entry, invalidation/stop, targets and risk/reward. It must not claim access to private trader positions or guarantee profits.
6. Run independent tests and security review before a separately approved live-trading capability.

## Safety distinction

Selecting REAL mode is only a preference and risk acknowledgement. It does not connect a broker, activate a bot, or place an order. Live execution remains disabled until a trusted server-side approval and safety workflow exists and has been tested.
