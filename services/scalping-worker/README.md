# Young Tiger continuous DEMO scalping market-data worker

This is a persistent, read-only market-data service. It is the first latency layer for the scalping engine; it deliberately does not place paper or broker orders.

## Runtime and deployment

Deploy as a Railway service from this repository with the root directory left at the repository root. Railway uses `services/scalping-worker/Dockerfile` and `services/scalping-worker/railway.json`.

Required service variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Expose the generated Railway domain on port 8080. Configure a health check at `/healthz`.

## Activation gate

The worker subscribes only to instruments belonging to a RUNNING DEMO Deriv session whose server-side `config_snapshot` contains all of:
- `account_mode: "DEMO"`
- `execution: "WEBSITE_PAPER_ONLY"`
- `scalping_enabled: true`

The instrument must also be present in the active, approved Deriv instrument registry. No browser value, client quote, or unapproved symbol can activate a feed subscription.

## Data path

- One persistent Deriv public WebSocket connection subscribes to approved symbols.
- Tick events are broadcast through Supabase Realtime on `scalping-market:<INSTRUMENT>`.
- A private latest-tick cache is persisted at most once per second per instrument in `public.scalping_market_ticks`.
- `GET /healthz` reports connection state, last tick time, subscription set, and processed tick count.

## Safety and rollout

- Read-only market-data feed: no order placement, no account tokens, no REAL mode.
- Keep the existing scheduled DEMO worker enabled for existing strategies while this feed is validated.
- Do not enable `scalping_enabled` for any account until the UI opt-in, strategy/risk controls, M1 history warm-up, paper-execution adapter, duplicate suppression, and independent end-to-end tests are released.
- Do not add the service-role key to a browser environment or commit it to the repository.
- Measure feed latency as `receivedAt - quoteAsOf`; do not claim a fixed millisecond execution time.
