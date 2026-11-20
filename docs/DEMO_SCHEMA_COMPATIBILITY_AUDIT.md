# DEMO database compatibility audit

Status: BLOCKED — review only; no production migration is approved by this document.

Branch reviewed: `upgrade/full-platform-build`  
Production schema baseline: Supabase schema inventory supplied by the project owner and the newer migrations on `main`.

## Safety decision

Do not merge the historical DEMO migrations or deploy the DEMO endpoints as a group until the application and database contracts are reconciled. The existing production tables contain live user/account records. Preserve them. Any future compatibility work must be additive, tested against a disposable database cloned from the production schema, and must not drop or rename existing columns or tables.

## Production table contracts currently known

- `demo_bot_sessions`: `id, user_id, broker, broker_account_ref, instrument, strategy, status, risk_per_trade_pct, max_daily_loss_pct, started_at, stopped_at, created_at, updated_at`.
- `demo_bot_trades`: `id, session_id, user_id, instrument, side, quantity, entry_price, exit_price, stop_loss, take_profit, pnl, status, opened_at, closed_at, metadata, created_at`.
- `bot_settings.id` is BIGINT, not UUID. Its known risk field is `risk_per_trade_pct`; the historical branch code frequently selects `max_risk_per_trade_pct`, which is not part of the supplied production table inventory.
- `bot_mode_profiles` and `bot_activity` are already present with production contracts that differ from the historical branch assumptions.
- `deriv_connections` is keyed by `user_id` and does not have an `id` column.

This inventory is a compatibility baseline, not a substitute for a fresh schema/constraint/RLS inspection before writing a migration.

## Historical branch assumptions that conflict

### Session model

The historical branch expects `demo_bot_sessions.bot_setting_id`, `account_mode`, `starting_balance`, `current_balance`, `virtual_currency`, `max_risk_per_trade_pct`, `max_daily_loss_pct`, and worker checkpoint fields. The production session contract instead records broker/account/instrument/strategy and does not include those balance or bot-setting fields.

Affected code includes:
- `api/bots/demo/control.js`
- `api/bots/demo/trade.js`
- `api/cron/demo-auto-worker.js`
- SQL functions in `202611120016_demo_auto_worker.sql`

### Trade model

The historical branch expects `symbol`, `direction`, `virtual_units`, `risk_amount`, `risk_pct`, `realized_pnl`, `quote_source`, `quote_as_of`, `trade_source`, TP-stage fields and mark fields. Production `demo_bot_trades` instead uses `instrument`, `side`, `quantity`, `pnl`, and `metadata` alongside the common lifecycle fields.

Affected code includes:
- `api/bots/demo/trade.js`
- `api/bots/demo/close.js`
- `api/bots/demo/mark.js`
- `api/cron/demo-auto-worker.js`
- SQL functions in `202611120016_demo_auto_worker.sql`

### Foreign-key and identifier mismatch

Historical migration `202611120005_demo_paper_trading.sql` declares `bot_setting_id` as UUID referencing `bot_settings(id)`. Production `bot_settings.id` is BIGINT. This foreign key cannot be applied as written. The UUID-default guards added to migrations 002 and 012 prevent one specific default-type failure; they do not resolve this foreign-key or application-contract mismatch.

### RPC contract mismatch

The worker/API calls RPCs including `open_demo_manual_trade`, `open_demo_auto_trade`, `close_demo_paper_trade`, and `manage_demo_auto_trade_exit`. Migration 016 defines `open_demo_auto_trade` and `close_demo_auto_trade`, with signatures and return shapes that do not match all callers. The endpoint and SQL function contracts must be reconciled before activation.

## Recommended ledger architecture

The follow-on design is documented in [DEMO_PAPER_LEDGER_V2_DESIGN.md](./DEMO_PAPER_LEDGER_V2_DESIGN.md). It proposes a separate additive `demo_paper_*` ledger so the deployed `demo_bot_sessions` and `demo_bot_trades` contracts remain untouched.

## Required next engineering sequence

1. Freeze production deployment of this historical DEMO path.
2. Inspect the complete production constraints, indexes, RLS policies, grants, triggers, and RPC signatures for the listed tables.
3. Implement and validate the dedicated additive `demo_paper_*` ledger design; do not overload existing production records.
4. Define one explicit schema contract and update every DEMO endpoint, worker, RPC, and test to use it consistently.
5. Add an additive migration only after testing it against a disposable copy of the production schema. Include idempotency, ownership isolation, service-role-only writes, and separate DEMO/REAL records.
6. Test manual entry/close, automated entry/management, duplicate worker prevention, stale quote rejection, daily loss lock, partial TP accounting, and user isolation.
7. Only then open an integration PR for review. Do not deploy or run the migration against production without explicit owner approval.

## Out of scope for this audit

This document does not authorize live broker execution, real-money orders, changes to Deriv OAuth scopes, production database writes, or deployment. DEMO must remain paper-only with verified market quotes; REAL execution remains separately gated and opt-in.


## 2026-11-20 implementation progress

An additive v2 paper-ledger migration is now present on `upgrade/full-platform-build` as `202611200001_demo_paper_ledger_v2.sql`. The DEMO control, manual entry/close/mark routes and scheduled worker have been switched to `demo_paper_*` records and v2 RPCs. This migration does not modify the legacy production `demo_bot_sessions`, `demo_bot_trades`, `bot_settings`, or broker tables. The v2 contract includes owner-only reads, service-role-only writes, per-user open-position uniqueness, quote freshness checks, USD-normalized risk sizing, Nairobi-day net-loss locking, worker lease, candle checkpoint and staged TP exits. The existing emergency-control latch is also checked.

**Not production-ready yet:** no Supabase migration has been applied; no disposable database integration test has run; CI has not yet completed for the latest revision. Do not deploy or merge until SQL is validated against a disposable database built from the current production schema, all tests pass, and the dashboard response compatibility is verified.


## Remaining DEMO integration gaps

- The repository contains a generic portfolio aggregation/monitoring library (`lib/portfolio-profit-protection.js` and `lib/portfolio-monitor.js`), a Supabase persistence adapter, a broker-neutral contract and unit tests. It applies the USD 20 activation threshold, 20% giveback, per-position peak tracking and one-account/mode scoping. A new additive migration `202611200002_portfolio_protection_state_v2.sql` now supplies the missing state columns, permission fields and `save_portfolio_profit_protection_state_v2` RPC expected by the adapter. **This migration has not been executed**. The DEMO portfolio adapter and monitor are now called by the existing scheduled worker while it holds the shared worker lease.
- The additive migration `202611200003_demo_multi_position_v3.sql` now removes the one-open-trade-per-user/session indexes in the isolated paper ledger, allows up to three open positions by default (maximum ten), and enforces a 2% aggregate remaining-risk cap under a session-row lock. The current strategy worker retains one BOT-managed position per session while allowing multiple MANUAL positions alongside it. The STATUS API returns `openTrades[]` with a backward-compatible `openTrade` alias, and the dashboard has a position selector. This supports multi-position paper ledger accounting, but it does not yet support multiple BOT instruments/sessions.
- The generic portfolio monitor and Supabase adapter now require a separate `closeManualTrades` permission. A manual position can be included in portfolio monitoring through `manual_trade_management`, but the monitor will not send a close request for it unless `close_manual_trades` is independently true. The additive migration, adapter mapping, scheduled DEMO worker and user-facing manual-position permission controls are now connected on the upgrade branch.
- A source review found malformed PL/pgSQL dollar-quote delimiters in the v2 migration. These delimiters have been corrected on this upgrade branch, but the SQL still has **not** been executed against a disposable PostgreSQL/Supabase instance. GitHub JavaScript CI does not compile or execute this SQL migration.
- The dashboard multi-position selector is implemented in source and covered by static tests; it still needs a live preview check. The worker and API need end-to-end testing with mocked/verified quote adapters and a disposable Supabase schema.


## 2026-11-20 follow-up review

The v2 migration's PL/pgSQL function-body delimiters were corrected after static inspection. This is a source correction, not proof that PostgreSQL accepts the full migration. No SQL was run and no database was changed.

The portfolio helper's manual-trade permission boundary was strengthened: monitoring/inclusion and the ability to close a manual position are now separate booleans. The helper unit test verifies that a manual position may contribute to combined portfolio P&L while only BOT positions are closed if the separate manual-close grant is absent.

Remaining activation blockers: execute migrations 001–003 against a disposable PostgreSQL/Supabase schema; test concurrency and close races; verify quote and conversion freshness with the live Deriv feed; inspect the dashboard in a browser; and verify the scheduled worker under a real cron lease. The portfolio monitor is DEMO-only and the adapter refuses REAL scopes. Atomic open-status checks prevent duplicate virtual closes; the monitor's state save uses compare-and-swap versioning.

The additive portfolio v2 migration and migration-contract regression tests are now present on the upgrade branch. These tests verify the adapter/schema names, separate manual-close permission, non-destructive migration intent and balanced SQL dollar-quote delimiters. They are static source-contract tests, not PostgreSQL execution tests.


The v3 multi-position migration and API/dashboard changes are source-complete for the first bounded multi-position iteration. The v4 portfolio adapter/runner is also connected to the scheduled DEMO worker: it loads every open virtual position for a user account, values each supported instrument using fresh Deriv quotes and USD conversion, persists the combined peak state, and uses the atomic paper-close RPC when the 20% giveback trigger is reached and permissions allow. Automatic BOT protection is on by default for DEMO; manual positions are excluded until the user opts in, and manual closing requires a second explicit permission. The database migrations remain unapplied; static tests do not prove SQL execution or end-to-end behavior.
