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

-- Existing admin membership table: authenticated users may read only their own row.
create table public.admin_users (user_id uuid primary key);
alter table public.admin_users enable row level security;
create policy "Users can check their own admin status" on public.admin_users
  for select to authenticated using (user_id = auth.uid());
grant select on public.admin_users to authenticated;

-- Existing SECURITY DEFINER helpers represented in the isolated migration test.
create or replace function public.is_traderwin_admin()
returns boolean language sql stable security definer set search_path=public
as $bootstrap$ select false $bootstrap$;

create or replace function public.traderwin_audit_account_mode()
returns trigger language plpgsql security definer set search_path=public
as $bootstrap$ begin return new; end $bootstrap$;

create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  active boolean not null default true
);
alter table public.service_catalog enable row level security;
create policy "Public read active services" on public.service_catalog
  for select to anon, authenticated using (active = true or is_traderwin_admin());


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


-- Minimal payment/subscription foundation for atomic entitlement integration tests.
alter table public.service_catalog
  add column service_code text unique,
  add column billing_period text not null default 'MONTHLY'
    check (billing_period in ('ONE_TIME','MONTHLY','YEARLY'));

create table public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service_code text not null references public.service_catalog(service_code),
  status text not null check (status in ('PENDING','PAID','FAILED','CANCELLED','REFUNDED')),
  created_at timestamptz not null default now()
);

create table public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service_code text not null references public.service_catalog(service_code),
  status text not null default 'PENDING',
  starts_at timestamptz,
  ends_at timestamptz,
  payment_order_id uuid references public.payment_orders(id),
  unique (user_id, service_code)
);
