-- Young Tiger FX: secure broker connection storage.
-- Safe to run more than once. Does not drop or replace existing data.

create table if not exists public.deriv_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  deriv_account_id text,
  encrypted_access_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reconcile older partial versions without replacing existing rows.
alter table public.deriv_connections
  add column if not exists deriv_account_id text;
alter table public.deriv_connections
  add column if not exists encrypted_access_token text;
alter table public.deriv_connections
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists deriv_connections_user_id_uidx
  on public.deriv_connections(user_id);

alter table public.deriv_connections enable row level security;
revoke all on public.deriv_connections from anon, authenticated;
grant all on public.deriv_connections to service_role;

comment on table public.deriv_connections is
  'Server-managed Deriv OAuth credentials. Tokens are encrypted before storage; never expose them to browser clients.';

-- The current dashboard omits market_category when saving a bot preference.
-- This default makes that existing insert compatible with the current schema.
alter table public.bot_settings
  alter column market_category set default 'Forex';
