# DEMO worker scheduling

The account-level DEMO portfolio monitor runs inside `POST /api/cron/demo-auto-worker`. The repository now declares a Vercel Schedule in `vercel.json` that calls this path every 15 minutes.

The worker endpoint requires:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

Vercel Schedules path targets send `Authorization: Bearer <CRON_SECRET>` automatically when the environment variable is configured. The endpoint acquires the shared database worker lease, processes a bounded set of DEMO sessions, runs the combined portfolio monitor, and releases the lease.

## Current schedule

```json
{
  "schedules": {
    "demo-auto-worker": {
      "schedule": "*/15 * * * *",
      "path": "/api/cron/demo-auto-worker",
      "requestMethod": "POST",
      "timezone": "Etc/UTC"
    }
  }
}
```

This cadence is deliberately compatible with Vercel Hobby and Pro:

- Hobby supports schedules no more frequent than every 15 minutes, uses a 15-minute jitter window, and includes 5,000 schedule runs per billing period. One 15-minute schedule uses about 2,880 runs in a 30-day month.
- Pro and Enterprise support every-minute schedules with a default one-minute jitter window. The current repository keeps the 15-minute cadence until a faster interval is explicitly selected.

On Hobby, the 15-minute jitter means an invocation can arrive up to 15 minutes after its scheduled time. This worker is therefore DEMO-only and is not a suitable real-money execution clock. Do not unlock REAL trading based on this scheduler.

## Activation gates

1. Apply migrations `202611200001` through `202611200004` to a disposable Supabase project and verify Auth, RLS, and PostgREST behavior.
2. Set `CRON_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` as server-side Production environment variables in Vercel. Never commit any secret.
3. Deploy the upgrade only after explicit production approval; Vercel applies the static schedule when the deployment becomes current.
4. Verify successful schedule runs and worker heartbeat timestamps in Vercel before enabling member DEMO automation.
5. Keep REAL execution disabled until secure Deriv/MT5 execution adapters, account authorization and live risk controls are independently validated.

The source schedule is configured in this branch, but it has not been activated in production because no merge or Vercel deployment has occurred.
