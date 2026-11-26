# DEMO daily account-equity protection

## Rule
The platform uses a fixed 20% daily loss limit measured against the account's opening balance at 00:00 Africa/Nairobi for that trading day. The baseline is account-wide and does not reset when a user starts another session or reaches a higher intraday profit.

Current equity is calculated as:

`opening balance + today's realized P/L + all open positions' floating P/L`

The limit triggers when current equity is less than or equal to 80% of the opening balance. For an opening balance of $100, $81 remains tradable and $80 triggers the lock.

## Actions
- All active DEMO sessions for the account are locked against new entries for the remainder of the Nairobi trading day.
- BOT-originated positions are automatically closed by the daily guardian; ordinary portfolio-management toggles do not disable this account-protection action.
- MANUAL-originated positions are included in equity valuation but are not auto-closed unless manual monitoring, explicit manual-close permission, and close-managed-positions permission are all enabled.
- Monitoring, verified quotes, stop-loss/take-profit management, and user-initiated manual closes continue after the lock.
- The next Nairobi day gets a new opening-balance snapshot. A previous day's lock does not carry into the new day after its open BOT positions have been safely handled.

## Implementation
- `demo_daily_risk_baselines` stores one immutable opening-balance snapshot per user and Nairobi trading date.
- The opening balance is reconstructed from the $10,000 DEMO seed plus realized ledger P/L, subtracting the current day's realization events.
- `evaluate_demo_daily_loss_guard` adds all current-day realized P/L and server-verified floating P/L, then atomically locks active sessions at the 20% threshold.
- The cron worker values every open DEMO position using fresh Deriv quotes and verified USD conversion before processing new BOT entries.
- If the daily equity valuation is unavailable or a session's user was not checked in the current worker tick, that session cannot open a new BOT trade.
- `close_demo_daily_loss_trade` enforces trade origin, account scope, explicit manual-close permissions for MANUAL positions, fresh quotes, and idempotency in the database.
- The atomic paper-entry RPC locks the daily baseline before the session row; a database insert trigger also rejects stale valuations or a reached daily limit, including direct batch-child inserts.

## Limits
The current DEMO worker is scheduled approximately once per minute. This is polling-based protection, not tick-level monitoring; a short-lived threshold crossing between polls may not be observed. Price gaps, liquidity, and quote availability can also affect the close price. The feature is DEMO paper-ledger only; it does not authorize REAL broker orders.
