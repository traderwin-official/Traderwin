# Schedule the Traderwin DEMO worker with Supabase Cron

Use Supabase Cron rather than Vercel Cron for the one-minute worker. Vercel Hobby limits scheduled jobs to once daily, while Supabase Cron supports minute-level schedules. Supabase stores the invocation secret in Vault, not in source code or a URL.

## 1. Configure the same secret in both services

Create a long random secret of at least 32 characters using a password manager or secure random generator. Do not send it in chat and do not commit it to GitHub.

In Vercel, open the Traderwin project settings and add this **server-side environment variable** for Production (and Preview only if you intend to test scheduled calls there):

- `CRON_SECRET` = your generated secret

Do not use a `NEXT_PUBLIC_` or browser-visible variable.

## 2. Enable the Supabase extensions

In Supabase Dashboard, open Database → Extensions and enable:

- `pg_cron`
- `pg_net`
- Supabase Vault (`supabase_vault`)

The SQL below assumes the extensions expose `cron`, `net` and `vault` schemas.

## 3. Store the worker URL and secret in Supabase Vault

Open SQL Editor and run this once. Replace only the placeholder secret with the exact same value saved as Vercel's `CRON_SECRET`.

```sql
select vault.create_secret(
  'https://traderwin-naq2.vercel.app/api/cron/demo-auto-worker',
  'traderwin_demo_worker_url',
  'Traderwin DEMO worker endpoint'
);

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_RANDOM_SECRET_AS_VERCEL_CRON_SECRET',
  'traderwin_demo_worker_secret',
  'Traderwin DEMO worker authorization secret'
);
```

If your production domain changes, update the URL secret using its Vault secret ID and `vault.update_secret`. Never put the secret in the endpoint URL, GitHub, a browser script or a public SQL migration.

## 4. Schedule one worker invocation every minute

Run this in Supabase SQL Editor after migration 016 and after the Vercel deployment is live:

```sql
select cron.schedule(
  'traderwin-demo-auto-worker',
  '* * * * *',
  $$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'traderwin_demo_worker_url'
    ),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'traderwin_demo_worker_secret'
      )
    ),
    timeout_milliseconds := 20000
  );
  $$
);
```

## 5. Verify it is running

Check that the job exists:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'traderwin-demo-auto-worker';
```

Check recent scheduled executions:

```sql
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (
  select jobid from cron.job
  where jobname = 'traderwin-demo-auto-worker'
)
order by start_time desc
limit 20;
```

The HTTP request is asynchronous. Inspect the recent HTTP responses too:

```sql
select status_code, error_msg, content, created
from net._http_response
order by created desc
limit 20;
```

Finally, sign in to Traderwin, start a Deriv DEMO session using the validated Multi-Confirmation strategy, and refresh the DEMO dashboard. The worker heartbeat should show its last check and action. A successful cron enqueue alone is not proof that the worker completed its task.

## Safety and scope

- The worker only reads Deriv market data and writes virtual DEMO ledger records.
- It does not send broker orders or manage REAL positions.
- Manual paper positions are deliberately excluded from automatic management.
- It currently supports a limited Deriv symbol set and one BOT-originated open position per DEMO session.
- If the worker heartbeat is missing, stale, or reports an error, do not assume automation is running. Stop the DEMO session while investigating.
