# Young Tiger FX — consolidated platform integration status

**Status date:** 2026-11-26  
**Development branch:** `integration/portfolio-scalping-stack-20261126`  
**Draft integration PR:** [#57](https://github.com/traderwin-official/Traderwin/pull/57)  
**Production site:** https://traderwin-naq2.vercel.app/

This is the current cross-platform checkpoint. It supersedes older progress snapshots where their branch names, PR numbers, feature claims or test counts differ. All implementation described here is branch work unless explicitly marked deployed.

## Product scope

Young Tiger FX is the platform. Strategies are independent optional modules. The integration must preserve manual trading, automated DEMO strategies, the strategy centre, charts and market watch, portfolio/account management, market intelligence, broker connections, signals, academy/education, memberships, payments and administration.

## Integrated work in the current draft PR

| Area | Current branch capability | Important boundary |
|---|---|---|
| Dashboard | Shortcuts for Trade DEMO, Strategy Centre, Portfolio, Market Analysis, Signals, Academy, Membership, Payments, Standalone Bot, Broker Connections, Account & Risk; Market Watch cards now load a shared instrument into chart, Analyst, bot settings and DEMO setup | Preview deployment remains blocked by Vercel build-rate limit |
| Manual and automated trading | Manual DEMO paper positions coexist with automated positions under shared capacity and portfolio risk controls | Manual positions are not silently enrolled in bot management |
| Strategy centre | Manual Trading, Smart Multi-Confirmation, Auto-select, Tiger Fibonacci Psychology, Quantum Scalping and Manual Review workflows | Scalping is optional, not the whole platform |
| Original automatic strategy | Liquidity-sweep continuation entry with reclaim and directional displacement; consolidation/retest is not mandatory for that setup | Sweep without follow-through is rejected; higher-timeframe, anti-chase, freshness, cooldown and risk gates remain |
| Quantum Scalping | DEMO worker, Deriv tick/candle feed, lease fencing, batch-entry idempotency/recovery, reconnect gap controls and full-position SL/TP exits | Worker image is CI-built only; not deployed to Railway or production |
| Portfolio | Account-scoped DEMO snapshots, fresh quote valuation, persistent peak tracking, 20% trailing giveback after combined USD 20 activation, shared position/risk caps | Manual monitoring and closing require separate explicit permissions; DEMO and REAL remain isolated |
| Deriv | OAuth/account verification foundation, explicit DEMO account selection and status checks | Verify actual production Auth/RLS and provider account behaviour before rollout |
| MT5 | Server-side HTTPS bridge client contract with DEMO-only validation and close disabled by default | No actual MT5 terminal bridge host, credentials or end-to-end connection |
| Market Analyst | Completed-candle technical analysis, next-higher-timeframe check, indicative bid/ask-based plan, BiQuote calendar context, GDELT news context/risk, XAUUSD independent gold reference | Deterministic research; no generative AI provider; no orders executed |
| M-Pesa and membership | STK Push/callback flow plus atomic subscription fulfilment ledger; duplicate and replay protection | Daraja production credentials, merchant approval and callback verification remain unconfirmed |
| Education/signals/admin | Existing dashboard routes and product areas retained | Full user journeys and role permissions still require browser/E2E validation |

## Unified Market Analyst output

The authenticated analyst now returns the individual provider results and a single `researchSummary` object that combines:

1. **Technical context:** selected-timeframe candidate, score, higher-timeframe direction and explanation.
2. **Fundamental context:** upcoming and blackout calendar events, event currency/category/relevance, GDELT headline topic/relevance, source and timestamp details.
3. **Market quality:** quote freshness, spread, instrument approval and indicative trade-plan state.
4. **Gold context:** XAUUSD independent reference price and broker discrepancy when available.
5. **Risk summary:** combined flags and market-intelligence gate decision.
6. **Execution boundary:** always `authorized: false`, `orderAction: NONE`, `mode: RESEARCH_ONLY`.

The summary is a presentation/aggregation layer. It does not change the execution gate, promote UNKNOWN to CLEAR, infer price direction from macro relevance or treat a technical score as win probability. GDELT headline labels are keyword-derived context, not validated sentiment. The current verified provider horizon is limited; absence of headlines or calendar results is not proof of a quiet market.

## Current validation checkpoint

- Latest Node workflow [#1151](https://github.com/traderwin-official/Traderwin/actions/runs/45823335313) passed **607/607 tests** (0 failed), including the regression assertion that the authenticated Analyst API wires `researchSummary`.
- Full Traderwin workflow [#1970](https://github.com/traderwin-official/Traderwin/actions/runs/45823252237) passed: Node tests, serverless syntax, inline page scripts, worker Docker image build and isolated PostgreSQL migration/integration checks.
- The latest branch head after those checks contains documentation-only updates; application code and tests are unchanged from the validated head.
- Vercel preview checks remain blocked by the account build-rate limit. No preview deployment is claimed.
## Not deployed / not yet verified

- No PR merge, production deployment or production Supabase migration has been performed.
- No Railway worker deployment has been performed.
- Disposable PostgreSQL migration tests do not establish compatibility with the live Supabase project's Auth, PostgREST, RLS or actual schema.
- Supabase Cron/Vault scheduling for the DEMO worker is not active until explicitly configured and verified in the target project.
- MT5 is a bridge-client foundation only, not an operational broker connection.
- M-Pesa live merchant/callback configuration is not confirmed.
- The analyst is not connected to a generative-AI API. A model provider, credentials, data policy and cost approval would be required before adding one.
- DEMO remains virtual paper execution. REAL execution remains locked and requires separate broker, subscription, risk, compliance, operational and explicit user approvals.

## Next combined engineering sequence

1. Validate the unified research summary and all API/UI contracts in CI.
2. Add end-to-end analyst checks for source freshness, provider failure, unsupported instruments, calendar blackout and gold-reference mismatch.
3. **Completed in the current branch:** Market Watch selection now synchronizes the chart, Analyst, bot preferences and DEMO setup; M5/M15/H1/H4 timeframe changes synchronize the chart, Analyst and DEMO strategy controls. Binary contract cards remain non-selectable as spot instruments. Regression tests cover the shared instrument/timeframe wiring.
4. Complete DEMO browser testing for sign-in, account mode, Deriv DEMO verification, market feed, strategy selection, risk settings, paper entries/exits, portfolio reconciliation, reconnect, daily-loss lock, kill switch and audit trail.
5. Verify disposable Supabase Auth/RLS/PostgREST behaviour before considering any production schema work.
6. Complete broker-specific MT5/Deriv operational testing and M-Pesa merchant verification separately.
7. Only after explicit approval, plan a reviewed release with rollback. No live execution switch is enabled by this development work.

## Non-negotiable safeguards

- No real-money order is sent by the research analyst or DEMO worker.
- Subscription payment alone never authorizes REAL trading.
- DEMO and REAL account state, balances, positions and permissions remain separate.
- Manual positions are not silently managed or closed by bots.
- Missing, stale, unsupported or contradictory evidence remains UNKNOWN/blocked.
- No paid plan, external service or provider API is enabled without explicit cost approval.
- Production changes, PR merge and deployment require explicit owner approval.
