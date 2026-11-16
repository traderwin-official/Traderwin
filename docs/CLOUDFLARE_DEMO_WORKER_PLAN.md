# Tiger Scheme — DEMO worker Cloudflare Cron migration plan

## Current source and scope

The current Vercel handler is `api/cron/demo-auto-worker.js`. It is a scheduled DEMO paper-trading worker, not a tick-by-tick scalper and not a REAL broker execution service. It currently processes a small batch of sessions on a one-minute cadence, records per-session heartbeats, uses a database lease, and returns `realOrdersSent: 0`.

Do not replace the Vercel schedule or expose the Cloudflare worker until the Cloudflare implementation passes the acceptance tests below and the owner approves the preview setup. Keep the Vercel endpoint available as rollback until cutover is separately approved.

## Target shape

- Add a separate `workers/demo-auto-worker/index.js` using the Cloudflare Workers `scheduled(controller, env, ctx)` handler.
- Add a separate `workers/demo-auto-worker/wrangler.toml` with a one-minute Cron Trigger (`* * * * *`).
- Use the existing Supabase project and existing service-role-only worker RPCs. Do not create a second trading database or copy user records.
- Keep the existing per-tick session limit and queue fairness. Do not run one task per user without a bounded batch.
- Keep the worker internal to Cron. If a manual diagnostic HTTP route is ever added, it must have separate strong authorization and must not be the scheduled entry point.
- Keep the worker explicitly DEMO-only. No Deriv trade endpoint, MT5 bridge, or REAL order API may be called.

## Required execution sequence

1. Claim the existing database lease with a fresh unique token and the approved lease duration.
2. If the lease RPC errors, fail closed. If another invocation owns the lease, return a skipped result without processing sessions.
3. Load only DEMO sessions eligible for management. Include PAUSED or RISK_LOCKED sessions only when they have an existing BOT-owned open paper position that still needs risk-reducing management.
4. For each session, verify user-owned settings, account mode, broker, emergency state, open-trade ownership and instrument identity.
5. Obtain a verified Deriv quote and, when a new entry is possible, completed candles for the exact saved instrument and timeframe. Reject future, stale, duplicate, out-of-order or mismatched market data.
6. Obtain and validate the quote-currency-to-USD conversion required by the DEMO ledger.
7. Run the deterministic strategy decision. New entries require a fresh, unprocessed completed candle and all risk gates. Existing BOT positions may only be marked, partially exited or closed through the approved atomic DEMO RPCs.
8. Record heartbeat and outcome for each processed session. One session failure must not falsely mark the other sessions as successful.
9. Release the lease in a `finally` block using the exact lease token. If release fails, report it and rely only on the database lease expiry for recovery; never release another invocation's lease.

## Mandatory acceptance tests before Cron deployment

### Duplicate prevention and concurrency
- Two simultaneous invocations produce only one lease owner.
- A second invocation exits without reading or changing sessions when the lease is held.
- A stale lease can be reclaimed after expiry.
- A wrong lease token cannot release another invocation's lease.
- Replaying the same completed candle cannot create a second paper trade.
- The database's unique/open-position and candle-checkpoint guards remain authoritative even if a Worker retry occurs after a timeout.

### Market-data integrity
- Reject a quote older than 30 seconds, a future quote, non-positive prices, wrong source or wrong instrument.
- Reject candles with wrong provider symbol, wrong instrument/timeframe, invalid OHLC, duplicate/out-of-order timestamps, incomplete candles, future timestamps or stale completed-candle timestamps.
- Reject a stale or mismatched USD conversion quote.
- No database trade mutation may occur when any required quote, candle or conversion check fails.

### Failure recovery
- A provider timeout, Supabase read error, decision exception or RPC error records an error outcome and does not fabricate a fill or successful close.
- The lease is released in `finally` after both normal and exceptional processing.
- If the process terminates before release, the lease expires and a later Cron tick can reclaim it.
- Heartbeat failures are surfaced; a heartbeat must not claim an action that the atomic RPC did not confirm.
- Partial results from one user must not prevent safe processing of other sessions within the bounded batch.

### Emergency stop and position ownership
- An active DEMO kill switch blocks every new automated entry.
- An existing BOT-owned DEMO position continues to receive only risk-reducing stop/target management where verified market data is available.
- A MANUAL paper position is never closed or managed by the unattended worker.
- PAUSED and RISK_LOCKED sessions cannot open new positions, but an already-open BOT position remains eligible for risk-reducing management.
- If emergency state cannot be verified and there is no open BOT position, fail closed and do not open.
- The worker never closes a REAL broker position and never sends REAL orders.

## Source dependency that must be fixed before porting

The currently open DEMO hardening PR `#14` adds USD-normalized RPC signatures in `supabase/migrations/202611160001_demo_daily_loss_partial_realizations.sql`. Its revised `manage_demo_auto_trade_exit` RPC requires `p_quote_to_usd`. The current source worker's STOP_LOSS call must be checked and corrected to pass that argument before it is ported; otherwise the RPC call will not match the new function signature.

That migration is authored only and has not been applied. Review it against the actual existing Supabase schema and the preceding migrations before seeking separate owner approval. Do not apply it as part of this hosting migration.

## Deployment gates

- First complete and test the Cloudflare Pages DEMO session and paper-trade endpoints.
- Reconcile the migration branch with the latest base changes and the open DEMO safety work before copying the worker implementation.
- Run the full test suite plus worker-specific concurrency, freshness, failure and emergency-stop tests.
- Only then prepare a non-production Cloudflare Worker preview with owner-configured server-side secrets.
- Do not change Supabase Cron, Vercel schedules, production DNS, live trading, or production traffic without explicit owner approval.

Oracle Cloud persistent bot hosting remains a later, separate stage. No Oracle VM is provisioned by this plan.
