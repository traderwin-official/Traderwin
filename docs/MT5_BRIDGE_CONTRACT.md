# Traderwin MT5 bridge contract

## Why MT5 uses a bridge

MetaQuotes' official Python integration communicates with an installed MetaTrader 5 desktop terminal. It is not a browser SDK and cannot be loaded directly inside a Vercel serverless function. Traderwin therefore uses a separately hosted, authenticated bridge that runs beside a logged-in MT5 terminal. The bridge is responsible for terminal lifecycle, account identity verification, market quotes, positions, currency conversion and broker-side order requests.

## Implemented in Traderwin

- A server-only HTTPS client in `lib/mt5-bridge-adapter.js`.
- Account/mode identity checks before accepting portfolio data.
- Strictly verified USD-normalized P&L; unknown conversion blocks protection.
- Position source classification (`BOT` / `MANUAL`) supplied by the trusted bridge.
- Idempotency key on close requests.
- Shared broker-neutral snapshot validation and adapter registry.
- Unit tests for account mismatch, valuation failure, HTTPS, and close routing.

## Required bridge endpoints

- `GET /v1/accounts/{accountRef}/portfolio`
  - Must authenticate the account and return `accountRef`, `accountMode`, `connected`, `quoteSource`, `asOf`, `maxQuoteAgeMs`, `emergency`, and all open positions.
  - Each position must include `ticket`, `source`, `valuationStatus`, `unrealizedProfitUsd`, `accountRef`, `accountMode`, `symbol`, `direction`, and `volume`.
  - Only return `valuationStatus: VERIFIED` when the terminal's account-currency profit and a fresh, verified currency conversion produce USD P&L. Never guess contract size or FX conversion.
- `POST /v1/accounts/{accountRef}/positions/{ticket}/close`
  - Require the idempotency header, verify account and mode again, confirm the current position still matches the ticket and expected source, and return the broker's actual execution result.
  - Never interpret an accepted request as a confirmed close unless the terminal/trade server confirms it.

## Security and rollout

- Keep `MT5_BRIDGE_URL` and `MT5_BRIDGE_API_TOKEN` in server-side environment variables only. Never expose either in dashboard JavaScript or logs.
- Bridge must use TLS, per-account authorization, request authentication, replay/idempotency protection, rate limits, audit logs and strict outbound network controls.
- Do not store the user's MT5 master password in Traderwin. Prefer the user's local terminal login or a dedicated, secured terminal host.
- Start with DEMO account verification and read-only snapshots. Enable close requests only after end-to-end demo tests, user permission checks and broker-side confirmation.
- REAL execution remains disabled until separate subscription, broker verification, risk acknowledgement and explicit real-trading authorization gates pass.
- A bridge outage or stale quote blocks new actions. Existing server-side broker SL/TP remains the primary protection; Traderwin's trailing monitor is supplementary and cannot guarantee a close during terminal, network or broker outages.

## Not yet operational

The bridge host/terminal, MT5 account verification flow, API credentials, server environment, and end-to-end DEMO tests still need to be provisioned. This repository client is an integration component, not proof of a connected or trading MT5 account.
