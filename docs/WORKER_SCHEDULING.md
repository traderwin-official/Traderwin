# DEMO worker scheduling

The account-level DEMO portfolio monitor is executed inside `GET /api/cron/demo-auto-worker`. The endpoint requires:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (at least 32 characters)

The endpoint checks `Authorization: Bearer <CRON_SECRET>`, acquires the database worker lease, processes a bounded set of DEMO sessions, runs the combined portfolio monitor, and releases the lease. It is safe against overlapping invocations through the shared database lease and atomic position-close RPCs.

## Current repository state

There is not yet a `vercel.json` cron declaration in this repository. The worker endpoint is implemented, but a recurring scheduler has not been configured. Do not describe the worker as running continuously until the scheduler is installed and a production heartbeat is observed.

## Scheduling choices

### Vercel Pro / Enterprise

Vercel's static Cron configuration supports a one-minute schedule on Pro and Enterprise. After confirming the project's plan and applying the database migrations, the production config can register:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/cron/demo-auto-worker",
      "schedule": "* * * * *"
    }
  ]
}
```

Vercel invokes the production route with the configured `CRON_SECRET` bearer token. Cron schedules use UTC.

### Vercel Hobby

Hobby Cron Jobs are limited to once per day and are not suitable for a one-minute trading worker. Do not add the one-minute schedule to a Hobby deployment because it can make deployment validation fail. A separate scheduler would be required; a GitHub Actions schedule can call the same endpoint at a coarser interval, but should be treated as best-effort and is not an acceptable execution clock for REAL trading.

### Vercel Schedules

Vercel announced Schedules in public beta in November 2026. This may be another option if the project has access, but availability and setup must be verified in the actual Vercel project before relying on it.

## Activation gates

1. Apply migrations `202611200001` through `202611200004` to a disposable Supabase project and verify Auth, RLS, and PostgREST behavior.
2. Configure the scheduler only after confirming the Vercel plan or approved alternative.
3. Set `CRON_SECRET` and the Supabase service-role key as server-side environment variables only; never commit either value.
4. Deploy the upgrade branch only after explicit production approval.
5. Verify worker invocations and heartbeat timestamps before enabling member DEMO automation.
6. Keep REAL execution disabled until secure Deriv/MT5 execution adapters, account authorization and live risk controls are independently validated.

No scheduler, Supabase migration, or Vercel deployment was changed as part of this source implementation.
