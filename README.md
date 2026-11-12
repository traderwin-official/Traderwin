# Traderwin

Traderwin is a multi-user trading research and risk-management platform being built around DEMO-first testing, Deriv market data, broker integrations, subscriptions and education.

## Current project state

- The upgrade is in draft PR #3 and is not merged.
- GitHub Actions runs unit tests, serverless syntax checks and inline-page-script checks on Node 22.
- The platform has a limited server-verified Deriv DEMO quote path and a rule-based live-market analyst.
- It is not yet an unattended automated trading system. The MT5 adapter, persistent bot worker and live broker execution remain unfinished and REAL trading stays locked.
- M-Pesa checkout requires merchant credentials and completed Supabase migrations.
- Vercel deployment is currently subject to the account's deployment API rate limit.

## Start here

- [Full platform architecture and migration guide](docs/FULL_PLATFORM_BUILD.md)
- [Release readiness, environment variables and remaining blockers](docs/CORE_UPGRADE_PLAN.md)

## Safety

DEMO uses virtual money. REAL account selection or subscription payment never authorizes live orders. No profits are guaranteed. Never commit Supabase service-role keys, broker tokens, M-Pesa credentials or encryption keys to the repository.