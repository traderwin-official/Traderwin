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
- The server-side entry RPC permits up to 15 concurrent DEMO paper positions, blocks duplicate M1-candle entries, caps each position at 0.25%, and limits combined open stop-risk to 1% of starting equity. The daily realized-loss cap is also 1%.
- Position size uses the verified USD value of the instrument's quote currency. Unsupported or stale conversions fail closed.
- Paper positions use staged exits: TP1 0.75R, TP2 1.1R, TP3 at the engine's 1.5R–3R target, with the existing 40/30/30 staged-close ledger and stop-loss.
- Exit decisions use the correct side of the spread: bid for BUY positions and ask for SELL positions. Missing bid/ask or stale quotes never trigger an exit.
- Database RPCs are the only entry/exit path. They are service-role-only and preserve the existing daily-realization and portfolio-protection ledger.

## Data path and health

- One persistent Deriv public WebSocket connection subscribes to approved symbols.
- M1/M5 history is warmed up before a symbol becomes ready.
- Latest ticks and signal candidates are persisted to private Supabase tables.
- Open scalping positions are refreshed without replacing in-flight trade state and managed concurrently from the same tick stream; each position can take profit or stop out independently while the others remain open.
- `GET /healthz` reports connection state, last tick, signal/entry/exit timestamps, subscription set and any last error.

## Safety and rollout

- DEMO virtual paper ledger only. The public Deriv WebSocket is read-only; no account token, OTP, broker order, or REAL execution is used.
- Do not deploy until the migration has been reviewed and explicitly approved for the target Supabase project.
- Do not add the service-role key to a browser environment, GitHub source, or chat.
- Keep the service stopped until code checks are green and the Railway trial credit balance has been checked. Do not upgrade to a paid Railway plan without the account owner's explicit approval.

## Historical strategy research

The repository also contains an offline research harness at `lib/scalping-backtest.js`.
It replays completed M1 candles, derives M5 confirmation only from prior complete candles,
evaluates entries at the next bar open, applies a fixed spread on both sides, adverse
slippage and round-trip commission assumptions, and resolves same-bar stop/target ambiguity
conservatively in favor of the stop. It reports expectancy, profit factor, win rate,
drawdown, losing streaks and a portfolio-risk-weighted return estimate.

Run the repository test suite with `npm test`. To evaluate a real strategy, supply
verified historical M1 OHLC data and instrument-specific spread, slippage and commission
assumptions. Synthetic test candles are only for checking code behavior; they are not
evidence of trading performance. This harness does not connect to a broker or execute orders.

To run the research harness against a local CSV file, use a header containing
`epoch,open,high,low,close` (or `timestamp` / `time` / `date` instead of epoch),
with one completed M1 candle per row in ascending time order. Session and weekend gaps are allowed; the backtester resets its warm-up after each gap and never bridges missing minutes:

```sh
node scripts/run-scalping-backtest.js ./xauusd-m1.csv XAUUSD 0.30 0.05 0.00 ./xauusd-report.json
```

The numeric cost inputs are price units for that instrument and must come from
realistic broker conditions. Do not copy the example assumptions as actual XAUUSD
spread or slippage values.

Deriv's public market-data WebSocket can download recent M1 candles without an account token.
Check the current active symbol name first (for example, do not assume a display label is the API symbol):

```sh
node scripts/fetch-deriv-m1-history.js frxXAUUSD 14 ./xauusd-m1.csv
node scripts/run-scalping-backtest.js ./xauusd-m1.csv XAUUSD 0.30 0.05 0.00 ./xauusd-report.json
```

The sample cost values above are placeholders only. Use actual broker spread,
slippage and commission assumptions before interpreting any result. The Deriv
download is Deriv market data, not an MT5 broker execution record.
