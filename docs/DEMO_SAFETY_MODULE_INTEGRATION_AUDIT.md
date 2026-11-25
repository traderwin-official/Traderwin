# DEMO safety-module integration audit

**Status:** isolated modules imported and unit-tested; integration deliberately pending  
**Reviewed:** 20 November 2026  
**Scope:** `upgrade/full-platform-build` only

## Executive decision

The ten safety modules under `lib/demo/` are present alongside their regression tests. The branch CI run #891 passed unit tests, serverless syntax checks, inline-page-script checks, and disposable PostgreSQL migration validation at commit `017b428ada0c47b8589a45ac08ebe5511ccf7b28`.

Passing isolated unit tests does not prove that the modules are compatible with the existing worker's runtime data contracts. They are not currently wired into `api/cron/demo-auto-worker.js`, `api/bots/demo/trade.js`, or the current decision pipeline. Keep them isolated until the adapters and end-to-end tests below are complete.

## Existing worker architecture to preserve

- `api/cron/demo-auto-worker.js` fetches Deriv quotes/candles, converts quote value to USD, calls `decideDemoAutoAction`, and commits paper opens/exits through atomic Supabase RPCs.
- `lib/demo-auto-decision.js` currently calls the existing root `lib/strategy-engine.js` function `analyseStrategy`. It is not calling the new `lib/demo/strategy-engine.js` function `evaluateDemoStrategy`.
- The existing worker uses a persistent candle checkpoint, worker lease, paper-only records, staged TP1/TP2/TP3 exits, and the portfolio-protection runner. Do not replace these controls with pure calculation modules.
- `api/bots/demo/trade.js` is a separate manual paper-entry path and currently uses `validatePaperSetup`, `calculatePaperPosition`, verified Deriv quote/FX conversion, and the atomic paper-trade RPC.

## Contract mismatches and prerequisites

| Module | Current contract / integration gap | Required before wiring |
|---|---|---|
| `candle-builder.js` | Accepts timestamped ticks (`epoch`, `quote`, `symbol`) and emits bucketed candles; current worker obtains provider OHLC history. | A separately tested tick-stream adapter, deduplication and persistent candle checkpoint strategy. Do not mix tick-built and provider candles without source identity. |
| `closed-candle-analysis.js` | Requires completed candles with `symbol`, `bucket_epoch`, `complete`; outputs the new SMA evaluator's signal schema. | A verified mapping from Deriv candle history, timeframe boundaries and current strategy configuration. Do not silently replace existing strategy semantics. |
| `strategy-engine.js` | Implements a generic SMA crossover, while the current worker supports `MULTI_CONFIRMATION_V1` and `TIGER_FIBONACCI_PSYCHOLOGY_V1`. | Strategy-by-strategy parity tests and explicit user/admin strategy selection. Keep generic SMA as a separate strategy, not a replacement. |
| `market-snapshot-validator.js` | Requires provider `DERIV_SERVER_ADAPTER`, `dataStatus: LIVE`, bid/ask, and an independently approved `instrumentActive` flag. | A trusted bid/ask feed adapter and a server-side instrument approval registry. Deriv's public active-symbol catalogue is discovery only and must not activate instruments. |
| `paper-eligibility-gate.js` | Requires `SERVER_VERIFIED` live feed status and a verified instrument-active boolean. | Populate these fields only from server-owned market-data and instrument-approval services; never trust browser-supplied flags. |
| `demo-entry-preflight.js` | Requires bid/ask snapshot, signal instrument, sizing status `VALIDATED`, `quantity`, `proposedRiskMoney`, plus complete portfolio/exposure contexts. | Build and test a server adapter that fetches all inputs and maps sizing outputs. It is DEMO-only and must run immediately before the atomic paper-entry RPC. |
| `risk-aware-lot-sizing.js` | Returns `status: SIZE_APPROVED`, `lots`, and `estimatedLossAtStop`; the preflight currently expects `status: VALIDATED`, `quantity`, and `proposedRiskMoney`. | Resolve the status/field mismatch with an explicit adapter and broker contract-spec validation. Never coerce lot size into quantity without instrument contract rules. |
| `portfolio-risk-guardian.js` | Requires trusted day-start equity, realized daily P&L, open-position stop risk and stop-scenario P&L. | Build a server-only account/position snapshot adapter with currency normalization, timestamps and missing-data fail-closed behavior. |
| `portfolio-exposure-guard.js` | Requires risk groups, notional exposure, risk money, and complete pairwise correlation data. | Obtain and timestamp a trusted correlation/exposure dataset; missing pairs must continue to block. Do not invent correlations. |
| `paper-exit-engine.js` | Evaluates one OHLC candle and can return a full close; current worker uses live quotes and atomic staged partial exits. | Decide and test the interaction with TP1/TP2/TP3, partial quantities, gaps, idempotency and the existing close RPC before any replacement. |

## Required integration sequence

1. Add typed/validated server-side adapters for market snapshots, instrument approval, account risk, position risk, correlation, broker contract specifications and lot sizing.
2. Add contract tests proving every adapter's output is accepted by its consumer and that missing/stale/ambiguous data fails closed.
3. Integrate the DEMO-only preflight into the worker's new-entry path first; leave the current open-position mark/exit path unchanged.
4. Re-fetch quote, account, positions, margin, emergency-stop state and risk immediately before the atomic paper-entry RPC. Treat preflight as approval-to-simulate only, not an execution authorization.
5. Add end-to-end worker tests for duplicate ticks, stale prices, wrong instruments, partial exits, worker lease expiry, concurrent sessions, daily loss limits, portfolio exposure, manual positions and emergency stop behavior.
6. Test against disposable Supabase/PostgreSQL and Deriv demo/sandbox data. Verify RLS, RPC ownership, idempotency and multi-user isolation.
7. Only after all checks pass, review a separate change for user-facing DEMO enablement. REAL mode remains independently locked behind its own broker, subscription, consent, permission and risk gates.

## Non-negotiable safety boundaries

- These modules perform calculations and validation only; none authorizes a broker order.
- DEMO records and REAL records remain isolated.
- DEMO quotes must be verified, timestamped and clearly identified; DEMO orders remain virtual.
- Do not activate instruments just because Deriv lists them as active.
- Do not enable manual-position closing through monitoring-only permissions.
- The combined 20% trailing giveback protection and its explicit manual-trade permission remain separate portfolio controls.
- Emergency stop blocks new entries; it does not automatically liquidate open positions.
- No production migration, production Supabase write, merge, deployment or REAL order is authorized by this audit.

## Validation evidence

- GitHub Actions run #891: passed at `017b428ada0c47b8589a45ac08ebe5511ccf7b28`.
- Validated stages: `npm test`, serverless JavaScript syntax, inline page scripts, disposable PostgreSQL migration tests.
- This run predates any future integration edits and does not validate production configuration or live broker connectivity.
