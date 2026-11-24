# Manual DEMO pending batch entries

## Implementation progress (2026-11-24)

The feature is now implemented in source on `feature/manual-partial-exits`:

- Dashboard asks for a positive whole-number trade count and a planned entry price.
- `POST /api/bots/demo/pending-batches` validates the owner, DEMO mode, session, instrument approval, fresh quote, entry side, target ordering, allocation total and aggregate risk.
- `demo_manual_entry_batches` stores one shared plan and reserves both aggregate risk and position slots while pending.
- The scheduled DEMO worker watches pending batches, verifies current Deriv quotes and instrument approval, then calls the atomic activation RPC.
- Activation creates all child paper positions in one database transaction at the planned entry price. Child positions share the same SL, T1/T2/T3 and percentages and are independently managed by the existing partial-exit engine.
- Pending setups can be cancelled. The worker blocks batches when the session stops, emergency stop activates, or instrument approval is revoked; stale/missing quotes defer activation without fabricating a fill.
- The legacy immediate manual-entry endpoint now returns HTTP 410 so it cannot bypass pending entry and aggregate reservations.
- A database trigger prevents ordinary manual/BOT opens from consuming risk or position slots reserved by pending batches.

The migration and SQL integration test are wired into GitHub Actions. This is source implementation, not proof of CI success or a live Supabase application. Apply the new migration only after CI validates it and after explicit production migration approval.



This is the design contract for the next manual-entry extension. It is intentionally separate from the already implemented staged partial-exit work.

## User workflow

The scheduled DEMO worker checks pending batches on its configured schedule (currently every minute under Supabase Cron). Activation occurs on the next fresh verified quote after a crossing is observed; it is not sub-second or tick-by-tick streaming execution. The scheduler is not active in production yet, so this code must not be treated as live until release gates and scheduling verification are complete.


A manual setup contains:
- instrument and BUY/SELL direction;
- requested entry price;
- number of trades to open (positive whole number, bounded by platform limits);
- stop-loss and T1/T2/T3 prices;
- three positive target allocations, totaling exactly 100%.

The setup is stored as one pending batch. It does not create open positions until the market reaches the requested entry trigger. On activation, it creates N independent MANUAL-origin DEMO paper positions. Every child has the same instrument, side, planned entry, SL, T1/T2/T3 and allocation percentages. Each child is independently tracked and can be partially exited at each target.

## Entry-price and touch semantics

The requested entry is a pending limit trigger, not the quote at form submission. For a BUY limit, the setup waits for a verified quote above the requested entry and activates on a subsequent verified quote at or below it. For a SELL limit, it waits for a verified quote below the requested entry and activates on a subsequent verified quote at or above it. A setup submitted when the quote is already on the triggered side is rejected for review rather than being silently filled at a different price. The worker must retain a verified pre-touch quote checkpoint; a first quote already beyond the level is not proof of a touch.

DEMO paper fills use the requested entry price, clearly labeled as simulated. They are not represented as broker executions. The app must disclose that real markets can gap or slip; REAL pending orders require broker-native pending-order semantics and cannot reuse this paper fill path.

## Batch risk and quantity

The requested count must not multiply the risk budget. Calculate one aggregate position size and aggregate stop-loss risk for the entire batch using the planned entry and stop. Split the total units and total risk allocation across N child positions deterministically (with final-child rounding remainder), and show both per-position and aggregate risk before submission. Reject the batch atomically if any child would exceed per-position limits, or if aggregate open-position count, open-risk, daily-loss, margin, instrument or emergency-stop limits would be exceeded. Reserve the aggregate risk while the batch is pending so multiple pending batches cannot overbook the account. Activation must re-check all limits atomically; if they no longer pass, leave the batch pending/blocked and create no child positions.

## Lifecycle and safety

- States: PENDING, ACTIVATING, ACTIVE, CANCELLED, EXPIRED, BLOCKED, FAILED.
- User can cancel a PENDING batch; cancellation and activation must serialize so only one wins.
- Stop/cancel the pending batch when its owning DEMO session is stopped, the emergency stop blocks entries, instrument approval is revoked, the account/session binding changes, or verified quote data is unavailable/stale. Do not fabricate an activation.
- Worker activation must be idempotent and transactional: one batch can create its N children exactly once. Record trigger quote, timestamp, source, planned entry and simulated fill price for audit.
- Each child then uses the existing permission-gated T1/T2/T3 partial-exit engine; SL closes the remaining quantity. If auto-exit permission is off, the worker must not close it.
- DEMO is paper-only. No Deriv/MT5 order is sent.
- REAL batch/pending entry is rejected until a verified broker adapter, broker-native pending-order handling, explicit scoped REAL entry and exit permissions, and live risk/consent gates are implemented.

## Required tests before merge

1. Count rejects zero, negative, fractional, non-numeric and above-limit values.
2. BUY and SELL pre-touch, exact-touch and cross-through activation.
3. No activation from a stale quote, mismatched instrument, future timestamp, or a first quote already beyond the trigger.
4. No duplicate activation under concurrent worker ticks/retries.
5. Cancellation racing activation has exactly one terminal outcome.
6. Batch creates exactly N child positions with identical levels and allocations.
7. Aggregate risk is conserved across N; pending reservations prevent overbooking.
8. Account open-count, aggregate-risk, daily-loss, emergency stop and instrument approval are rechecked at activation.
9. Session stop, revoked instrument approval and missing quotes block/cancel safely.
10. Each child independently executes partial exits at T1/T2/T3 and closes only its remaining units at SL.
11. REAL mode is rejected and no broker-order adapter is invoked.
