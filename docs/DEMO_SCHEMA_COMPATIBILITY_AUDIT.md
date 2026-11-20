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

- The v2 worker currently manages one open paper position per user and implements staged TP exits and daily-loss locking. It does **not** yet implement the agreed combined 20% portfolio giveback monitor (USD 20 activation) across multiple positions, nor the explicit manual-trade monitoring/close permission workflow. Those must be added before claiming full portfolio risk protection.
- The SQL migration has not been executed against a disposable PostgreSQL/Supabase instance in this environment. GitHub CI validates JavaScript tests and syntax only; it does not compile or execute this SQL migration.
- The dashboard still needs a live preview check against the new response fields, and the new worker needs end-to-end testing with mocked/verified quote adapters and a disposable Supabase schema.
