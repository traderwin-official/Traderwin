# Traderwin core upgrade

This branch is isolated from the live `main` branch.

## Verified current baseline
- Supabase email/password authentication exists.
- The dashboard contains TradingView charts and a basic risk calculator.
- Bot preferences are stored with automation disabled; there is no running bot engine.
- Deriv OAuth routes exist, but the callback stores a null Deriv account ID and there is no verified order-execution workflow.
- No MT5 execution service, AI market-data pipeline, or completed M-Pesa checkout/callback flow is present in the repository.
- TradingView chart prices are indicative, not executable broker quotes.

## Included
- First-login DEMO/REAL mode onboarding.
- Per-user risk preferences, RLS and an account-mode audit trail.
- A server-controlled `real_trading_enabled` gate that browser clients cannot change.
- A correctly located shared AES-256-GCM token-encryption helper for the legacy callback import.
- Dashboard status messages that keep bot configuration DEMO-only and automation OFF.

## Required setup
1. Review and run `supabase/migrations/202611120001_trader_profiles.sql` in Supabase SQL Editor.
2. Keep `SUPABASE_SERVICE_ROLE_KEY`, `DERIV_OAUTH_SECRET`, and `TOKEN_ENCRYPTION_KEY` in Vercel server-side environment variables only.
3. Verify the Deriv OAuth redirect URI matches the registered Deriv callback URL.
4. Do not enable live orders until broker verification, token encryption/decryption, order sizing, stop-loss and daily-loss enforcement, duplicate-order protection, a kill switch, audit logging and demo tests are complete.

## Later stages
1. Complete Deriv account verification and a demo-only order lifecycle.
2. Build and test the MT5 bridge against a broker demo account.
3. Add admin/member roles, service entitlements, M-Pesa STK Push, signed callback validation and idempotent payment records.
4. Add an AI market analyst using licensed market data and public, legally accessible sentiment sources. Ideas must include timestamps, sources, reasoning, entry, invalidation/stop, targets and risk/reward. Do not claim access to private trader positions or guarantee profits.
5. Run independent tests and a security review before separately approving any live-trading capability.

## Safety
Selecting REAL is a preference and risk acknowledgement only. It does not connect a broker, activate a bot or place an order. Live execution remains disabled until a trusted server-side approval and safety workflow is implemented and tested.
