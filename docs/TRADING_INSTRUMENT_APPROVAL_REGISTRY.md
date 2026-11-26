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

`api/router.js` routes `/api/admin/instruments` to `handlers/admin/instruments.js`, which authenticates a bearer session with Supabase, then checks `traderwin_admin_roles` and requires the exact `ADMIN` role. SUPPORT and ANALYST cannot mutate the registry. The endpoint supports:

- `GET`: list registry entries; `GET ?audit=1` returns the latest 100 audit events.
- `POST action=register`: create a PENDING, inactive row only.
- `POST action=approve`: explicitly approve the exact broker/instrument/provider-symbol tuple, recording the authenticated admin and a required reason.
- `POST action=disable`: disable the exact tuple and record the authenticated admin and reason.

The API ignores any browser-supplied approver identity. The audit trigger falls back to the server-stamped `updated_by` field so the actor is retained even when the service-role database connection has no end-user JWT subject. CI now includes migration and SQL integration checks for RLS, privileges, approval constraints and audit events.

## DEMO entry integration now in place

`lib/deriv/load-approved-instrument.js` reads the registry using the server-side database client and fails closed on missing rows, query errors, disabled/pending rows, ambiguous matches, or provider-symbol mismatch. It never accepts approval state from the browser.

Both entry paths now enforce this allowlist:

- Manual DEMO: checks the initial server quote, then repeats the registry check against the final refreshed quote immediately before the atomic paper-entry RPC.
- Automated DEMO: after refreshing the server quote and rerunning the strategy decision, checks the exact approved provider-symbol mapping before the atomic paper-entry RPC.

An empty registry therefore blocks all new manual and automated DEMO entries. Existing open positions can still be marked and managed; disabling an instrument blocks new entries and does not silently liquidate an existing position.

## Remaining market-data limitation

The current public Deriv adapter returns a single timestamped tick, not a bid/ask market snapshot. Do not fabricate bid/ask by applying a guessed spread or duplicating the mid/last price. The separate market-snapshot validator remains unintegrated until a genuine provider-backed bid/ask source and exact provider contract mapping are available.

## Remaining validation

The approval resolver, server-side lookup helper and both worker integrations have targeted tests. Full CI is running against the latest branch head. The disposable PostgreSQL integration must also pass before this migration is considered validated. None of these changes have been applied to production Supabase or deployed.

The registry alone is not an order authorization. It does not enable an instrument automatically, authorize REAL trading, or replace account verification, user consent, quote validation, position sizing, portfolio risk, or emergency controls.
