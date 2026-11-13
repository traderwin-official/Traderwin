# Automatic TP1 / TP2 / TP3

Traderwin's staged take-profit plan is broker-neutral and uses risk multiples from the initial entry and stop distance:

- TP1: 1R, close 40% of the original position.
- TP2: 2R, close 30% of the original position.
- TP3: 3R, close the entire remaining position.

The DEMO Deriv worker evaluates the stop first, then the next uncompleted target. It executes only one target stage per worker tick and uses an atomic Supabase RPC to update remaining virtual units, cumulative realized P&L, the virtual balance, target progress and daily-loss protection together.

The broker-neutral lib/take-profit-manager.js is the shared execution contract for Deriv and MT5 adapters. It validates account identity, quote freshness, minimum volume and volume steps, requires exact broker confirmation of the requested partial volume, and supplies a stage-specific idempotency key. A progress write failure after a broker-confirmed close is reported as RECONCILE; the adapter must reconcile the broker's actual remaining volume before retrying.

DEMO and REAL scopes are never mixed. REAL execution requires a separate positive authorization check. MANUAL positions require an explicit canManageManualPosition permission check; monitoring does not grant close permission.

## Activation status

This code is added to the development branch only. Apply the new Supabase migration after reviewing the existing migration sequence, then run the complete DEMO worker and broker end-to-end tests. The Deriv DEMO paper path is wired in code but is not active until the migration and worker deployment are configured. The REAL Deriv/MT5 broker adapters are not connected by this change and must remain disabled until their separate account verification, permissions, broker-native protection and end-to-end tests pass.
