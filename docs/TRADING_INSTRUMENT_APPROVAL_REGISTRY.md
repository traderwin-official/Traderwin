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

## Administrative controls now in place

`api/admin/instruments.js` authenticates a bearer session with Supabase, then checks `traderwin_admin_roles` and requires the exact `ADMIN` role. SUPPORT and ANALYST cannot mutate the registry. The endpoint supports:

- `GET`: list registry entries; `GET ?audit=1` returns the latest 100 audit events.
- `POST action=register`: create a PENDING, inactive row only.
- `POST action=approve`: explicitly approve the exact broker/instrument/provider-symbol tuple, recording the authenticated admin and a required reason.
- `POST action=disable`: disable the exact tuple and record the authenticated admin and reason.

The API ignores any browser-supplied approver identity. The audit trigger falls back to the server-stamped `updated_by` field so the actor is retained even when the service-role database connection has no end-user JWT subject. CI now includes migration and SQL integration checks for RLS, privileges, approval constraints and audit events.

## Deliberately not wired into trading yet

The manual and automated DEMO entry workers do not yet call the registry. Before wiring them:

1. Add a trusted Deriv quote adapter that returns a validated bid/ask snapshot and exact provider symbol.
2. Query the registry with service-role credentials, fail closed on lookup errors, and verify the live quote's provider symbol against the approved mapping.
3. Repeat approval, quote freshness, emergency-stop and risk checks immediately before the atomic paper-entry RPC.
4. Test the full manual and automated paths against disposable Supabase/PostgreSQL and Deriv sandbox fixtures.

The registry alone is not an order authorization. It does not enable an instrument automatically, authorize REAL trading, or replace account verification, user consent, quote validation, position sizing, portfolio risk, or emergency controls.
