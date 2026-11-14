# Young Tiger FX — production readiness and broker integration policy

## Project continuity
Young Tiger FX is the public brand of the existing Traderwin codebase. Keep the same GitHub repository, Supabase project, Vercel project, authentication users and database. Do not create a replacement project or database.

## Verified codebase status at this audit
- Static HTML dashboard with TradingView chart embed, risk calculator, authentication and account-mode onboarding.
- Tiger AI marketing/interface section is present; it is not yet a connected AI inference service.
- Bot settings can be saved, but there is no persistent strategy scheduler, market-data ingestion pipeline, execution worker, order reconciliation service or production bot engine.
- Deriv OAuth start/callback code exists. The callback currently saves a null Deriv account ID; OAuth completion is not equivalent to verified trading permissions or working order execution.
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
