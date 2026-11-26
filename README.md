# Young Tiger FX

Young Tiger FX is the rebranded continuation of the existing Traderwin project. It retains the same GitHub repository, Supabase project, Vercel project connection and existing user database. No new project or database is created.

## Current verified baseline
- Supabase email/password authentication and DEMO/REAL preference onboarding.
- Market dashboard, TradingView chart embeds and educational risk calculator.
- Tiger AI product identity and dashboard section.
- Deriv OAuth initiation/callback code exists but is not yet a verified trading integration.
- No production bot execution engine or completed MT5 bridge is currently deployed.

See `docs/PRODUCTION_READINESS.md` for broker compatibility, safeguards and remaining release gates.

## Platform architecture

Young Tiger FX is the platform; strategies are optional modules inside it. Quantum Scalping is one strategy and must not replace manual trading, other strategies, portfolio/account management, market intelligence, education, membership, payments or administration.

See [Strategy and Platform Architecture](docs/STRATEGY_ARCHITECTURE.md) for platform-wide product boundaries and the Quantum Scalping strategy contract.
