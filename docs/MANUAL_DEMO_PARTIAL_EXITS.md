# Manual DEMO partial exits

Manual website entries are DEMO paper positions only. They never send Deriv or MT5 broker orders.

## Entry

The manual entry panel requires:
- A verified server-side entry quote.
- A stop-loss.
- Ordered T1, T2 and T3 prices beyond the entry in the BUY or SELL direction.
- Three positive exit allocations whose sum is exactly 100%.

The allocation percentages apply to the original virtual position quantity. For example, 40% / 30% / 30% closes those portions at T1, T2 and T3. The final target closes the remaining quantity to eliminate rounding dust. If the stop-loss is reached first, it closes the entire remaining quantity.

## Automatic-exit permission

The scheduled DEMO worker processes MANUAL positions only when the owner has enabled `auto_exit_manual_brackets` for the matching DEMO Deriv account. Monitoring-only permission does not grant exit authority. The portfolio 20% giveback permission remains independent.

The worker obtains a fresh verified Deriv public quote, confirms the trade's DEMO session and broker-account scope, then calls the service-role-only `manage_demo_manual_partial_exit` RPC. The RPC re-checks the owner, MANUAL origin, DEMO session, dedicated permission, fresh quote, target ordering/stage and threshold crossing while locking the trade row. Stop-loss exits close the remaining quantity.

The user-triggered DEMO mark endpoint applies the same partial-exit RPC only when this dedicated permission is enabled. Without it, marking a position only updates its verified mark; the user can still close the position manually.

## REAL mode

This implementation does not open or manage REAL positions. The manual-entry API explicitly rejects REAL account mode. REAL staged exits must wait for a separately implemented and tested broker adapter, verified account binding, explicit live-trading permission and per-action execution authorization. A DEMO permission or subscription never authorizes a REAL order.

## Database

Apply `supabase/migrations/202611240002_manual_demo_partial_exits.sql` after the existing manual DEMO bracket migration. It adds the percentage fields, migrates legacy open single-target manual positions to a 100% T1 allocation, and creates service-role-only open/exit RPCs.
