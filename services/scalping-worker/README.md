# Young Tiger continuous DEMO scalping worker

A persistent Deriv public market-data worker for **Tiger Scheme AI Bot — Quantum Scalping**. It generates M1/M5 candidates and manages virtual DEMO paper positions in Traderwin's isolated `demo_paper_*` ledger. It does not send Deriv broker orders and cannot execute REAL trades.

## Runtime and deployment

Deploy as a Railway service from this repository with the root directory left at the repository root. Railway uses `services/scalping-worker/Dockerfile` and `services/scalping-worker/railway.json`.

Required service variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Expose the generated Railway domain on port 8080. Configure a health check at `/healthz`.

## Entry activation gates

The worker opens a paper position only for a session that:
- belongs to the user's own Deriv DEMO paper ledger;
- is RUNNING and has both feed access (`enabled`) and a separate explicit automatic paper-trading opt-in (`paper_execution_enabled`) in the private `demo_scalping_preferences` row;
- has `account_mode: "DEMO"` and a supported paper-only execution setting in its server-side `config_snapshot`;
- uses an active, explicitly approved Deriv instrument;
- has fresh, timestamped Deriv bid and ask values and a fresh quote-currency-to-USD conversion.

Enabling the feed alone never opens a position; `paper_execution_enabled` defaults to false and must be explicitly enabled from the dashboard. Either disabled flag blocks new entries. Existing scalping BOT positions remain subscribed and managed to their stop or staged targets even if the user disables new entries or pauses the session.

## Strategy and execution

- M1 is the fast entry timeframe; completed M5 candles confirm direction.
- The strategy uses EMA9/EMA21, RSI14, ATR/spread filters, momentum breakout and Fibonacci context.
- Conflicting or incomplete conditions return WAIT.
- The server-side entry RPC enforces one open DEMO position per user, candle idempotency, no more than 0.25% risk per trade and a 1% daily-loss cap.
- Position size uses the verified USD value of the instrument's quote currency. Unsupported or stale conversions fail closed.
- Paper positions use staged exits: TP1 0.75R, TP2 1.1R, TP3 at the engine's 1.5R–3R target, with the existing 40/30/30 staged-close ledger and stop-loss.
- Exit decisions use the correct side of the spread: bid for BUY positions and ask for SELL positions. Missing bid/ask or stale quotes never trigger an exit.
- Database RPCs are the only entry/exit path. They are service-role-only and preserve the existing daily-realization and portfolio-protection ledger.

## Data path and health

- One persistent Deriv public WebSocket connection subscribes to approved symbols.
- M1/M5 history is warmed up before a symbol becomes ready.
- Latest ticks and signal candidates are persisted to private Supabase tables.
- Open scalping positions are refreshed from the private paper ledger and managed from the same tick stream.
- `GET /healthz` reports connection state, last tick, signal/entry/exit timestamps, subscription set and any last error.

## Safety and rollout

- DEMO virtual paper ledger only. The public Deriv WebSocket is read-only; no account token, OTP, broker order, or REAL execution is used.
- Do not deploy until the migration has been reviewed and explicitly approved for the target Supabase project.
- Do not add the service-role key to a browser environment, GitHub source, or chat.
- Keep the service stopped until code checks are green and the Railway trial credit balance has been checked. Do not upgrade to a paid Railway plan without the account owner's explicit approval.
