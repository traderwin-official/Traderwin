# Young Tiger FX — production readiness and broker integration policy

## Project continuity
Young Tiger FX is the public brand of the existing Traderwin codebase. Keep the same GitHub repository, Supabase project, Vercel project, authentication users and database. Do not create a replacement project or database.

## Verified codebase status at this audit
- Static HTML dashboard with TradingView chart embed, risk calculator, authentication and account-mode onboarding.
- Tiger AI marketing/interface section is present; it is not yet a connected AI inference service.
- The integration branch contains a continuous DEMO-only paper scalping worker with a persistent Deriv public quote feed, lease-fenced paper-trade entry/exit, portfolio risk controls and recovery logic. It is not deployed to Railway and does not submit live broker orders. A production REAL execution engine is not approved or implemented.
- Deriv OAuth start/callback code verifies and sanitizes the provider-returned account list, stores encrypted access tokens server-side, and supports explicit DEMO account selection. The integration branch now marks a connection healthy only when the selected DEMO account is still present and active in the verified account list and the authorization token is unexpired. OAuth connection is not equivalent to working broker order execution.
- No completed MetaTrader 5 bridge or general broker adapter is present.
- Existing payment callback code is not a complete, verified M-Pesa checkout and entitlement lifecycle.
- A prior database migration exists for trader profiles. Do not assume every later requested table or migration has been applied; reconcile schema against Supabase before executing new SQL.

## Broker compatibility policy
A broker can only be connected where it provides a documented and permitted integration path, the account type supports the requested actions, and the broker permits automated trading for that customer and jurisdiction. There is no universal connector that safely works with every broker.

| Integration family | Intended support | Current status |
|---|---|---|
| Deriv | Official OAuth/API where account and scopes allow | OAuth scaffold exists; account identity, token lifecycle, demo order flow and reconciliation remain incomplete |
| MetaTrader 5 | Broker-authorized Expert Advisor/terminal bridge or approved API | Not implemented; requires a separately operated, secured bridge and broker-specific validation |
| REST/WebSocket brokers | Per-broker official API adapter | Future adapter family; each broker requires its own documented adapter |
| FIX/API institutional brokers | Contracted FIX/API connection | Only after written broker approval, credentials, certification and operational controls |
| Browser-only/manual brokers | No scraping or credential automation | Not supported unless an official permitted API becomes available |

Never collect a user's broker password, bypass broker controls, scrape private web sessions, reverse-engineer undocumented endpoints, or imply that a broker's general API access automatically permits third-party commercial bot operation.

## Required controls before any live execution
1. Broker-by-broker permission and jurisdiction review; record API terms, permitted account types, instruments, order types, rate limits and approval evidence.
2. User-owned broker authorization with least-privilege scopes; encrypted tokens at rest, rotation/revocation, access logs and no secrets in browser code.
3. Demo-only integration tests, order lifecycle reconciliation, idempotency keys, duplicate-order prevention and recovery after timeouts/restarts.
4. Server-side hard limits: maximum order size, leverage/exposure, per-trade risk, daily loss, open positions, instrument allowlists, price deviation and trading-session rules.
5. Independent kill switch, stale-price protection, connection-loss handling, market-halt handling, margin checks and fail-closed behaviour.
6. Persistent audit records for signals, model/version, inputs, decisions, approvals, requests, broker responses, fills, cancellations and operator actions.
7. User consent and clear disclosures of strategy behaviour, fees, conflicts, data sources, execution model, slippage and loss risks.
8. Independent security review, penetration testing, disaster recovery and signed release approval before real-money use.

A dashboard toggle, subscription payment or broker login must never by itself activate live trading. DEMO and REAL records, credentials, positions and balances must remain separate. Real mode remains disabled until the complete server-side approval workflow passes.

## Regulatory note
No software build can certify itself as compliant with every broker, regulator or country. The legal position depends on the services actually provided (software, signals, advice, portfolio management, order routing or execution), the operator's role, customer locations and broker agreements. Obtain qualified legal/compliance review before offering live execution or personalized investment advice in each target market. In Kenya, review the Capital Markets Act and the Capital Markets (Online Foreign Exchange Trading) Regulations, 2017, and consult the CMA where the business model may fall within a regulated activity. In other jurisdictions, map applicable rules before onboarding residents.

For example, the FCA's algorithmic-trading rules require resilient systems, limits, prevention of erroneous orders, continuity, testing and monitoring for firms within scope. ESMA's MiFID II Article 17 likewise sets systems, risk-control, testing and recordkeeping requirements for covered investment firms. These are useful engineering benchmarks, not a blanket licence or a statement that every retail user is regulated as an investment firm.

## Current release decision
**Not approved for live automated trading.** Keep all bots OFF by default and demo-only until the above controls and broker-specific approvals are implemented and independently tested. Marketing must not claim guaranteed profits, universal broker compatibility, regulatory approval or completed AI execution.


## 2026-11-14 implementation update
- Public dashboard header/footer legacy logo text corrected to Young Tiger FX.
- Deriv OAuth request now asks for `trade account_manage` scopes. The registered Deriv OAuth application must permit these scopes.
- Added migration `202611140001_platform_foundation.sql` for missing platform data structures using `CREATE TABLE IF NOT EXISTS`, indexes and row-level security. Existing tables are not dropped or overwritten.
- Live execution remains blocked. This update does not create a working bot worker, Deriv OTP/WebSocket order lifecycle, MT5 bridge, or verified payment settlement.


## 2026-11-26 integration-branch validation update
- The integration branch contains optional independent strategies; Quantum Scalping remains a DEMO paper strategy and does not replace manual trading or other platform strategies.
- DEMO paper scalping uses a continuous Deriv public quote feed, lease-fenced server-side paper execution, atomic batch entry, idempotent recovery, stale-feed safeguards and full-position stop-loss/final-take-profit exits.
- DEMO manual and bot positions share a portfolio capacity limit while manual positions remain outside bot management unless the account owner separately grants the relevant permissions.
- Deriv connection health now requires both an unexpired authorization token and a matching active DEMO account in the provider-verified account list. REAL account metadata does not unlock REAL trading.
- Latest integration CI at this checkpoint passed 577 tests, dashboard script checks, worker image build and disposable PostgreSQL DEMO/portfolio migration validation, including authenticated user-scoped account-mode profile reads. This is branch validation only; it is not a production deployment or live-broker certification.
- Vercel preview builds are currently blocked by the account build-rate limit. Do not upgrade the plan or incur costs to bypass it without explicit approval.
- M-Pesa settlement is still not production-certified. The integration branch now adds a service-role-only transactional entitlement RPC and permanent per-payment-order ledger so duplicate and historical callbacks cannot extend a subscription twice; PostgreSQL replay tests are included in CI but must pass before this is considered validated.
- A broker-authorized MT5 bridge, independent AI inference service, production operational review and all REAL execution approvals remain outstanding.
- The M-Pesa callback permits a previously verified PAID order to retry subscription fulfilment after payment-state recovery; fulfilment now delegates to the atomic database transaction rather than a separate client-side upsert.

- Dashboard mode-profile reads explicitly authenticate the current user and scope the DEMO/REAL preference query to that user's row, avoiding ambiguous profile reads across accounts.
