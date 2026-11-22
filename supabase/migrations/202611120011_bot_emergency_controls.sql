-- Per-account emergency stop latch. It halts new bot entries; it is not an order-close command.
-- Broker/account execution adapters must still reconcile positions and independently verify protective stops.
create table if not exists public.bot_emergency_controls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_mode text not null check (account_mode in ('DEMO','REAL')),
  broker text not null check (broker in ('DERIV','MT5')),
  broker_account_ref text not null check (length(trim(broker_account_ref)) between 1 and 200),
  kill_switch_active boolean not null default false,
  reason text,
  changed_at timestamptz not null default now(),
  unique (user_id, account_mode, broker, broker_account_ref)
);
alter table public.bot_emergency_controls enable row level security;
revoke all on public.bot_emergency_controls from public, anon, authenticated;
comment on table public.bot_emergency_controls is
  'Server-controlled per-user/account emergency entry-stop latch. It does not close positions or grant close permission. Service role only.';
