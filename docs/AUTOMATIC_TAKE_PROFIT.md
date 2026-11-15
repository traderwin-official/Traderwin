# Automatic TP1 / TP2 / TP3

Traderwin's staged take-profit plan uses the initial entry and stop distance:

- TP1: 1R, close 40% of the original position.
- TP2: 2R, close 30% of the original position.
- TP3: 3R, close the entire remaining position.

The percentages are based on the original volume, not recalculated as a percentage of the reduced volume. For a 1.00-lot position, TP1 closes 0.40, TP2 closes 0.30, and TP3 closes the final 0.30. After every confirmed partial close, the manager uses the broker's actual remaining units for the next stage. The original entry, stop and TP prices never restart or move because of a partial close.

The DEMO Deriv worker evaluates the stop first, then the next uncompleted target. It executes only one target stage per worker tick and uses an atomic Supabase RPC to update remaining virtual units, cumulative realized P&L, virtual balance, target progress and daily-loss protection together.

The 20% portfolio giveback monitor remains independent of TP stages. It continues to total unrealized USD profit across eligible open positions in the same broker account and account mode. Its peak is stored per position on a per-unit basis: when TP1 or TP2 reduces a position's units, that position's old peak is scaled to the remaining units; when TP3 removes a position, the peaks of other open positions are preserved. New positions start with their current profit as their baseline. This prevents partial closes or unrelated position closures from distorting the portfolio giveback calculation. The $20 activation threshold and 20% giveback rule remain unchanged.

The broker-neutral `lib/take-profit-manager.js` validates account identity, quote freshness, minimum volume and volume steps, requires exact broker confirmation of the requested partial volume, and supplies a stage-specific idempotency key. A progress write failure after a broker-confirmed close is reported as RECONCILE; the adapter must reconcile the broker's actual remaining volume before retrying.

DEMO and REAL scopes are never mixed. REAL execution requires a separate positive authorization check. MANUAL positions require an explicit `canManageManualPosition` permission check; monitoring alone never grants close permission.

## Activation status

These changes are on the development branch only. Apply migrations 019 and 020 after reviewing the existing Supabase schema, then run the full test suite and DEMO end-to-end tests. The Deriv DEMO paper path is wired in code but is not active until the migrations and worker deployment are configured. The REAL Deriv/MT5 broker adapters are not connected by this change and must remain disabled until their separate account verification, permissions, broker-native protection and end-to-end tests pass.
