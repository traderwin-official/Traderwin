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

## Required next engineering sequence

1. Freeze production deployment of this historical DEMO path.
2. Inspect the complete production constraints, indexes, RLS policies, grants, triggers, and RPC signatures for the listed tables.
3. Choose a canonical virtual-ledger design that fits the production schema. Prefer a dedicated additive paper-ledger table set if the current tables are used for a different purpose; do not overload existing production records.
4. Define one explicit schema contract and update every DEMO endpoint, worker, RPC, and test to use it consistently.
5. Add an additive migration only after testing it against a disposable copy of the production schema. Include idempotency, ownership isolation, service-role-only writes, and separate DEMO/REAL records.
6. Test manual entry/close, automated entry/management, duplicate worker prevention, stale quote rejection, daily loss lock, partial TP accounting, and user isolation.
7. Only then open an integration PR for review. Do not deploy or run the migration against production without explicit owner approval.

## Out of scope for this audit

This document does not authorize live broker execution, real-money orders, changes to Deriv OAuth scopes, production database writes, or deployment. DEMO must remain paper-only with verified market quotes; REAL execution remains separately gated and opt-in.
