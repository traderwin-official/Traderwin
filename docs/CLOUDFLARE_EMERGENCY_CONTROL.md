# Tiger Scheme — Cloudflare emergency controls

The Cloudflare Pages Functions route `/api/bots/emergency/control` mirrors the existing Vercel emergency entry-stop API.

## Supported methods

- `GET`: read the authenticated user's emergency latch for one account.
- `POST` with `action: STATUS`: read the latch.
- `POST` with `action: STOP_ENTRIES`: activate the entry kill switch.
- `POST` with `action: CLEAR_STOP`: clear the entry kill switch.

Every request requires a Supabase bearer session. DEMO references are server-defined as `DEMO:<authenticated-user-id>`. REAL requests additionally require a matching `broker_connections` row with the same owner, broker, account ID, REAL mode, CONNECTED status and a verification timestamp.

The endpoint only changes the new-entry latch. It does not close, liquidate, or otherwise manage an open position, and clearing the latch does not authorize REAL execution. Existing broker, quote, risk, subscription and execution gates remain independent.

## Runtime requirements

Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as server-side Cloudflare Pages environment secrets. Never expose the service-role key in browser code or chat. The existing Supabase emergency-controls migration must already be present in the target database; this migration work does not apply it.

The original Vercel route remains in place as a rollback reference. Do not switch production traffic until the Cloudflare preview is configured and the endpoint has been tested against the existing Supabase schema.
