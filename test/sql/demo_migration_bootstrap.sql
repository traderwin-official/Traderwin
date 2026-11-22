-- Disposable PostgreSQL bootstrap for syntax/integration validation of the
-- isolated DEMO ledger and portfolio migrations. Never run against production.
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end
$$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- Minimal shape of the already-deployed foundation table. The migrations under
-- test must add to this table without replacing or dropping its existing data.
create table public.portfolio_profit_protection_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null,
  broker_account_ref text not null,
  account_mode text not null check(account_mode in ('DEMO','REAL')),
  peak_unrealized_profit_usd numeric not null default 0,
  protection_active boolean not null default false,
  monitor_manual_trades boolean not null default false,
  updated_at timestamptz not null default now(),
  unique(user_id,broker,broker_account_ref,account_mode)
);

-- Existing Deriv connection foundation shape for additive account-picker tests.
create table public.deriv_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  deriv_account_id text,
  demo_account_id text,
  real_account_id text,
  encrypted_access_token text not null,
  token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
