# Young Tiger FX

Young Tiger FX is the rebranded continuation of the existing Traderwin project. It retains the same GitHub repository, Supabase project, Vercel project connection and existing user database. No new project or database is created.

## Current integration checkpoint

The latest combined development status, capabilities, limitations, validation and next steps are documented in [Platform Integration Status](docs/PLATFORM_INTEGRATION_STATUS.md).

The active development work is in draft PR #57. It is not production deployment. DEMO automation, portfolio safeguards, market analysis, subscription reliability and broker foundations are under integration testing; actual provider, Supabase and browser verification remain release gates.

See [Production Readiness](docs/PRODUCTION_READINESS.md) for deployment safeguards and [Strategy Architecture](docs/STRATEGY_ARCHITECTURE.md) for platform-wide product boundaries.

## Platform architecture

Young Tiger FX is the platform; strategies are optional modules inside it. Quantum Scalping is one strategy and must not replace manual trading, other strategies, portfolio/account management, market intelligence, education, membership, payments or administration.

See [Strategy and Platform Architecture](docs/STRATEGY_ARCHITECTURE.md) for platform-wide product boundaries and the Quantum Scalping strategy contract.
