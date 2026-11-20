# DEMO paper ledger v2 — implementation design

Status: design proposal only. No production migration or deployment is authorized.

## Decision

Use a dedicated additive paper-ledger schema rather than changing the meaning of the existing production `demo_bot_sessions` and `demo_bot_trades` tables. The current production tables already have a different, deployed contract. Reusing those names for a second contract would keep causing runtime and migration conflicts.

Proposed tables:

- `demo_paper_sessions`: UUID primary key; `user_id` FK to auth.users; broker and broker account reference; instrument; strategy; timeframe; status; virtual currency; starting/current virtual balance; risk-per-trade and daily-loss limits; started/stopped timestamps; worker candle checkpoint; timestamps.
- `demo_paper_trades`: UUID primary key; session/user FKs; instrument; side; entry/stop/target/exit prices; virtual quantity; risk amount and percentage; quote-to-USD conversion; quote source and quote timestamp; status; realized P&L; trade origin (BOT or MANUAL); TP1/TP2/TP3 stage quantities and completion flags; mark/peak fields; open/close timestamps; metadata.
- `demo_paper_worker_heartbeats`: one row per session, owner-scoped read policy, service-role writes.
- `demo_paper_worker_leases`: service-role-only singleton lease to prevent overlapping worker invocations.
- `demo_paper_emergency_controls`: service-role-only entry-stop latch scoped to user, broker and DEMO account reference.

Existing production tables remain untouched. Existing user data remains intact.

## Invariants

1. Every paper session and trade is explicitly DEMO; no REAL rows can be inserted into this ledger.
2. All writes occur through service-role-only, security-definer RPCs with fixed search paths and strict input validation. Authenticated users receive owner-scoped SELECT only.
3. User identity is derived from a validated bearer token in API routes; client-supplied user IDs are never trusted.
4. Quotes must come from a verified provider adapter, match the selected instrument, and pass freshness checks. Persist provider/source and timestamps.
5. Virtual balance, realized P&L, partial take-profit accounting, daily loss and worker checkpoints update atomically.
6. **Interim v2 limitation:** the current ledger enforces one open paper position per user. This is not sufficient for the agreed account-wide portfolio guard. Before that guard is activated, replace the single-position restriction with an account-scoped multi-position model, atomic per-account position caps and worker/API/dashboard support for arrays of open positions. Never remove the unique index without completing that coordinated redesign.
7. Worker leases prevent overlapping cron runs. A candle checkpoint prevents duplicate entries on the same completed candle.
8. Emergency stop blocks new entries. It does not close an existing position or bypass normal stop/target management.
9. Manual positions are never automatically closed unless the user explicitly enables the separate close-management permission. Monitoring-only is not close authorization.
10. DEMO APIs never call broker order endpoints. Tests must assert zero broker execution calls.

## Proposed API contract

Keep existing route URLs for UI compatibility, but move their database access to the new `demo_paper_*` tables and corresponding RPCs. Define one shared server-side repository module so route handlers do not embed divergent table/column assumptions.

- `POST /api/bots/demo/control`: START, STOP, STATUS.
- `POST /api/bots/demo/trade`: create a manual paper position from a fresh verified quote.
- `POST /api/bots/demo/close`: close a manual paper position from a fresh verified quote.
- `POST /api/bots/demo/mark`: update valuation only; no order execution.
- `GET|POST /api/cron/demo-auto-worker`: lease, process eligible sessions, write heartbeat, release lease.

All RPC names and signatures must be versioned and tested against the same migration. Do not mix the old `open_demo_auto_trade` / `close_demo_auto_trade` contract with the newer manual-trade RPCs.

## Migration requirements before implementation

- Create only new `demo_paper_*` tables, indexes, constraints, functions and policies.
- Do not alter, rename, truncate, or drop existing `demo_bot_sessions`, `demo_bot_trades`, `bot_settings`, `bot_mode_profiles`, `bot_activity`, or broker tables.
- Do not create a foreign key from a UUID to `bot_settings.id` (BIGINT). Store a nullable text snapshot of the bot configuration or reference a compatible UUID profile if one is formally selected.
- Add RLS and grants explicitly; authenticated users get SELECT only for rows where `auth.uid() = user_id`; all inserts/updates/deletes are service-role-only.
- Test migration idempotency and all RPCs against a disposable Supabase database created from the current production schema/migrations.
- Verify indexes, constraints, grants, RLS policies and function ownership with catalog queries before any production approval.

## Delivery gates

1. Implement migration and shared repository adapter.
2. Update route handlers and worker to use the new contract.
3. Add unit tests for risk calculations and decision logic plus API/RPC integration tests.
4. Test user isolation, concurrent opens, worker lease expiry, duplicate candles, stale/mismatched quotes, daily loss locks, partial TP accounting, stop/target exits, and manual-trade permission boundaries.
5. Run CI and inspect the full diff.
6. Open a draft PR for owner review. Production migration and deployment remain separate explicit approvals.


## Portfolio protection integration status (2026-11-20)

- Shared aggregation and monitoring code is present in `lib/portfolio-profit-protection.js` and `lib/portfolio-monitor.js`. It uses the USD 20 activation threshold, a 20% trailing giveback, USD-normalized position valuations, per-position peak tracking and one-account/one-mode scoping.
- `lib/supabase-portfolio-adapters.js` provides service-role state/permission persistence. The additive migration `202611200002_portfolio_protection_state_v2.sql` supplies the versioned JSON peak state, compare-and-swap RPC and separate `close_manual_trades` permission expected by the adapter.
- Monitoring/inclusion of manual trades (`manual_trade_management`) and permission to close manual trades (`close_manual_trades`) are separate. The latter defaults to false. A global `close_managed_positions` grant is also required before any portfolio close request.
- This is not yet an operational service: no scheduled portfolio worker loads all DEMO paper positions, computes their fresh USD valuations, or sends idempotent virtual closes. The current DEMO ledger still has one open position per user. The persistence migration has not been run against PostgreSQL or Supabase.
- Do not enable portfolio auto-closing until the multi-position ledger, dashboard position list, account-level quote/valuation adapter, worker scheduling, permission settings and disposable-database integration tests are complete.
