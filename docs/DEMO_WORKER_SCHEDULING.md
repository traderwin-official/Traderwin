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

Run this in Supabase SQL Editor only after the additive migrations `202611200001` through `202611200006` and `202611210001` have been reviewed, applied to the intended project, and verified; the production worker route must also be deployed.

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
- Manual paper positions are included in combined monitoring only when the member explicitly enables monitoring. Individual manual DEMO SL/TP auto-exits are checked separately and require the dedicated `auto_exit_manual_brackets` opt-in for that DEMO Deriv account. This permission does not enable portfolio giveback closing; the two permissions are independent. The new RPC in migration `202611240001_manual_demo_bracket_auto_exit.sql` rechecks the dedicated permission and exact bracket price inside the database transaction.
- It currently supports a limited approved Deriv symbol set and one BOT-originated open position per DEMO session, alongside bounded MANUAL paper positions.
- If the worker heartbeat is missing, stale, or reports an error, do not assume automation is running. Stop the DEMO session while investigating.


## Daily loss locks and existing positions

A session marked `RISK_LOCKED` must not open another position. If it still has a BOT-originated DEMO position open, the worker continues to monitor that position and process its stop-loss and staged take-profit exits. This prevents a daily loss lock from abandoning an existing virtual position without risk management.

Daily realized loss includes each partial TP/stop realization on the Nairobi calendar date when that stage is recorded. A manual DEMO close is committed through one atomic database function so the trade status, cumulative realized P&L, virtual balance and daily risk lock cannot drift apart.

The additive migration `202611210001_demo_paper_daily_realization_events.sql` records partial-realization deltas in the isolated v2 paper ledger. Do not assume it is installed until it has been reviewed and applied to the correct Supabase project.


## USD-normalized DEMO P&L

The paper ledger is denominated in USD. Instruments whose quote currency is not USD require a fresh Deriv conversion quote (for example, USDJPY uses the inverse USDJPY rate, while EURGBP uses GBPUSD). If the conversion quote is missing, stale, mismatched or unsupported, the entry/mark/close operation fails closed rather than labelling raw quote-currency P&L as USD. Synthetic indices and other instruments without verified USD contract valuation are not eligible for USD-risk DEMO trading until their contract valuation is verified.

The entry conversion factor is retained for audit. Realized P&L is converted using the fresh quote-currency-to-USD rate at each exit stage.
