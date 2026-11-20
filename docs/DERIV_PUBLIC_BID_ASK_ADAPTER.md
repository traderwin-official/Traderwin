# Deriv public bid/ask snapshot adapter

**Status:** adapter and contract tests added; not wired into any entry path  
**Scope:** `upgrade/full-platform-build`

## Provider contract

Deriv's public WebSocket `ticks` response documents `bid` and `ask` as optional fields. `pip_size` is the only required property in the tick object. A tick may therefore contain a last/spot `quote` without either side of the market.

The existing `getDerivPublicQuote` now preserves provider-supplied numeric `bid` and `ask` values and stamps each side with the same tick timestamp. It does not derive either value from `quote`.

`getDerivPublicMarketSnapshot` converts that tick into the `DERIV_SERVER_ADAPTER` contract only when:
- the source is the server-side Deriv adapter;
- the requested instrument matches the tick instrument;
- a provider symbol is present;
- both bid and ask are finite, positive provider values;
- ask is not below bid;
- both side timestamps exactly match the same tick timestamp;
- the timestamp is no more than 30 seconds old and is not materially in the future.

Missing or invalid sides throw a blocked error. No midpoint/spread is synthesized, and this adapter does not query or mutate the instrument approval registry. Registry approval remains a separate prerequisite.

## Integration boundary

This adapter is deliberately not wired into manual or automated DEMO entries yet. Existing paper entries continue to use the established single-quote path. The stricter snapshot validator and entry preflight remain isolated until their other account, sizing, margin, portfolio-risk and exposure inputs have trusted adapters and end-to-end contract tests.

## Verification required

- Contract tests cover provider identity, instrument mismatch, stale/future timestamps, missing sides, invalid prices, crossed markets and side timestamp mismatch.
- Verify Deriv actually supplies both optional fields for each approved instrument in the target environment; if it does not, keep new entries blocked for that feed/instrument.
- Do not infer that a valid public tick or active-symbol listing grants platform instrument approval.
- No production migration, merge, deployment, real broker order or live-trading enablement is part of this change.


## Registry integration

`lib/deriv/load-approved-market-snapshot.js` now joins the provider snapshot with the private `trading_instrument_approvals` registry and the strict market validator. It requires the exact active APPROVED Deriv/provider-symbol tuple, a fresh snapshot (10-second default), and a spread within 0.5% (default). Database errors, missing approval, stale data and excessive spread all block eligibility. This coordinator is tested but is not yet connected to any entry route.
