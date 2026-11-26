# Young Tiger FX strategy and platform architecture

## Platform first; strategies are modules

Young Tiger FX is the complete trading platform. A trading strategy is one optional capability that runs inside the platform; it is not the platform identity, navigation structure, or a replacement for other trading workflows.

The platform must preserve and progressively improve these product areas:

- **Trading workspace:** market watch, charts, instrument search, watchlists, price sources, alerts and order tickets.
- **Manual trading:** manual DEMO and, only after all live-release gates pass, explicitly authorized REAL positions.
- **Strategy centre:** a catalogue of independent strategies with per-strategy descriptions, supported markets/timeframes, risk profiles, enable/disable controls and status.
- **Automated trading:** strategy scheduling, signal evaluation, paper execution, broker adapters, order lifecycle reconciliation and audit trails.
- **Portfolio and account management:** positions from manual and automated workflows, account balances, exposure, risk limits, permissions and profit protection.
- **Market intelligence:** news/calendar vetoes, technical analysis, instrument eligibility, source timestamps and explainable trade decisions.
- **Education and membership:** learning resources, signals, subscriptions, payment entitlements and member support.
- **Administration and operations:** user roles, approvals, monitoring, security events, feature flags, incident controls and service health.

Features should be integrated into the existing navigation and shared account/portfolio model where appropriate. A strategy-specific worker or service must never take over the whole dashboard or disable unrelated features.

## Quantum Scalping

Quantum Scalping is one optional Young Tiger FX strategy module. It is designed for short-duration entries and exits and is not a default mode for every trader.

Current branch implementation scope:
- DEMO paper execution only; the worker does not send broker orders.
- Deriv public quotes/candles, subject to instrument approval and freshness checks.
- One final take-profit target per scalping position. At that target the whole remaining position closes; stop-loss also closes the whole remaining position. No TP1/TP2 staged partial exits for this fast scalping strategy.
- Manual trades keep their separate manual partial-exit workflow and permissions. Scalping rules must not change manual-trade behaviour.
- Portfolio-level risk limits, shared position ceiling, worker lease fencing, duplicate-entry protection, quote validation, reconnect handling and auditability.
- Strategy-level opt-in and per-session controls. Other strategies and manual trading remain independently available.
- A future strategy may define different exit behaviour only through its own explicit strategy configuration and tested execution contract.

The legacy TP1/TP2 database columns are compatibility markers for the existing entry ledger only. They are not executable scalping exit stages. The worker uses the single `take_profit` target.

## Cross-platform invariants

1. A strategy can be enabled, disabled, tested or upgraded without replacing the platform.
2. Manual positions are never silently enrolled in automated management.
3. Strategy permissions are scoped to that strategy, account mode and broker account.
4. DEMO and REAL balances, credentials, positions and execution records remain separate.
5. A subscription payment or dashboard toggle never authorizes REAL execution by itself.
6. Missing, stale or contradictory market evidence fails closed for automated entries/exits.
7. Shared portfolio controls must account for all positions without silently changing ownership or management permissions.
8. Strategy-specific failures must not disable charts, education, membership, account management or unrelated strategies.
9. New strategy modules require isolated tests and integration tests against shared account and portfolio rules.
10. Production releases require explicit approval, tested rollback and broker-specific live authorization.

## Release boundary

The integration branch contains development work only. Passing CI or creating a pull request does not mean the worker is deployed, market feeds are fully certified, a broker integration is production-ready, or REAL trading is authorized. No production deployment or production database migration is implied by this document.
