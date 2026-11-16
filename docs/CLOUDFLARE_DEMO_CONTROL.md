# Tiger Scheme — Cloudflare DEMO session control

The Pages Function at `POST /api/bots/demo/control` provides the existing DEMO session lifecycle actions:

- `START`: starts or resumes a virtual DEMO session after account-mode, strategy, timeframe, risk, existing-session, open-position and emergency-latch checks.
- `STOP`: stops new entries. If a BOT-owned virtual position remains open, the session is paused so the scheduled worker can continue risk-reducing management; it does not close the position.
- `STATUS`: returns the authenticated user's latest DEMO session, open paper position and worker heartbeat.

Every request requires a Supabase bearer session and all session/trade reads and writes are scoped to the authenticated user. Only Deriv is currently supported for unattended DEMO automation. REAL mode is rejected.

The route creates virtual ledger sessions only. It does not place broker orders. The existing one-minute worker remains a separate Vercel route until its Cloudflare Cron port passes lease/duplicate, stale-market-data, failure-recovery and emergency-stop tests.

## Runtime

The route uses the existing Supabase project and server-side service-role binding. It does not change the database schema or apply migrations. The existing emergency-controls table must already exist in the Supabase database; otherwise START fails closed.
