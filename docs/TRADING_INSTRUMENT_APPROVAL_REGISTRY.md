# Trading instrument approval registry

## Purpose

The registry is a server-managed allowlist. Deriv's public `active_symbols` endpoint remains discovery-only: seeing a symbol from Deriv must never create, activate, or approve it for Young Tiger FX trading.

## Schema

Migration `202611200006_trading_instrument_approval_registry.sql` adds:

- `trading_instrument_approvals`: one row per broker/instrument, with an exact provider symbol mapping, approval state, active flag, approver and timestamp.
- `trading_instrument_approval_audit`: append-only audit events written by a database trigger for inserts, updates and deletes.

Only `service_role` receives table privileges. RLS is enabled and browser roles receive no access. An empty registry denies every instrument. New rows default to `PENDING` and inactive. Only `APPROVED` rows with `is_active=true`, `approved_by`, and `approved_at` satisfy the database constraints.

## Server resolver

`lib/deriv/instrument-approval.js` implements a pure fail-closed resolver. It requires exactly one matching row and checks broker, approval state, active flag, approver metadata, provider identity, and exact provider-symbol mapping. It does not call Deriv, trust browser-provided registry rows, or create trades.

## Deliberately not wired yet

This migration and resolver are foundation only. They are not yet called by the manual or automated DEMO entry workers. Before wiring them:

1. Inspect the actual admin identity/role model and add a server-only administrative approval endpoint; never accept an admin flag from the browser.
2. Add an audit reason and explicit approve/disable actions with authorization tests.
3. Add a trusted Deriv quote adapter that returns a validated bid/ask snapshot and exact provider symbol.
4. Query the registry with service-role credentials, fail closed on lookup errors, and verify the live quote's provider symbol against the approved mapping.
5. Repeat approval, quote freshness, emergency-stop and risk checks immediately before the atomic paper-entry RPC.
6. Test the full manual and automated paths against disposable Supabase/PostgreSQL and Deriv sandbox fixtures.

The registry alone is not an order authorization. It does not enable an instrument automatically, authorize REAL trading, or replace account verification, user consent, quote validation, position sizing, portfolio risk, or emergency controls.
