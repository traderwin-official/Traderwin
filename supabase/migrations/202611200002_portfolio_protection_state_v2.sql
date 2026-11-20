-- Additive portfolio-protection persistence contract.
-- Compatible with the deployed 202611140001 foundation table: no existing rows,
-- tables, broker records, or legacy columns are dropped or renamed.

alter table public.portfolio_profit_protection_state
  add column if not exists current_unrealized_profit_usd numeric(18,6) not null default 0,
  add column if not exists protected_profit_floor_usd numeric(18,6) not null default 0,
  add column if not exists activation_threshold_usd numeric(18,6) not null default 20,
  add column if not exists giveback_pct numeric(5,2) not null default 20,
  add column if not exists trailing_active boolean not null default false,
  add column if not exists included_position_ids text[] not null default '{}',
  add column if not exists position_peak_state jsonb not null default '{}'::jsonb,
  add column if not exists membership_version bigint not null default 0,
  add column if not exists state_version bigint not null default 0,
  add column if not exists last_valuation_at timestamptz,
  add column if not exists quote_source text,
  add column if not exists quote_as_of timestamptz;

create table if not exists public.portfolio_trade_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_mode text not null check(account_mode in ('DEMO','REAL')),
  broker text not null check(broker in ('DERIV','MT5')),
  broker_account_ref text not null,
  manual_trade_management boolean not null default false,
  bot_trade_management boolean not null default true,
  close_managed_positions boolean not null default true,
  close_manual_trades boolean not null default false,
  permission_granted_at timestamptz,
  permission_revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,account_mode,broker,broker_account_ref)
);

alter table public.portfolio_trade_permissions
  add column if not exists bot_trade_management boolean not null default false,
  add column if not exists close_managed_positions boolean not null default false,
  add column if not exists close_manual_trades boolean not null default false;

alter table public.portfolio_trade_permissions alter column bot_trade_management set default true;
alter table public.portfolio_trade_permissions alter column close_managed_positions set default true;

alter table public.portfolio_profit_protection_state enable row level security;
alter table public.portfolio_trade_permissions enable row level security;

revoke all on public.portfolio_profit_protection_state from anon,authenticated;
revoke all on public.portfolio_trade_permissions from anon,authenticated;
grant select on public.portfolio_profit_protection_state to authenticated;
grant all on public.portfolio_profit_protection_state to service_role;
grant all on public.portfolio_trade_permissions to service_role;

create or replace function public.save_portfolio_profit_protection_state_v2(
  p_user_id uuid,
  p_account_mode text,
  p_broker text,
  p_broker_account_ref text,
  p_peak_profit_usd numeric,
  p_current_profit_usd numeric,
  p_protected_floor_usd numeric,
  p_trailing_active boolean,
  p_included_position_ids text[],
  p_position_peak_state jsonb,
  p_membership_version bigint,
  p_state_version bigint,
  p_expected_state_version bigint,
  p_last_valuation_at timestamptz,
  p_quote_source text,
  p_quote_as_of timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_user_id is null
     or p_account_mode is null or p_account_mode not in ('DEMO','REAL')
     or p_broker is null or p_broker not in ('DERIV','MT5')
     or p_broker_account_ref is null or nullif(trim(p_broker_account_ref),'') is null
     or p_peak_profit_usd is null or p_peak_profit_usd < 0
     or p_current_profit_usd is null
     or p_protected_floor_usd is null or p_protected_floor_usd < 0
     or p_trailing_active is null
     or p_included_position_ids is null
     or p_position_peak_state is null or jsonb_typeof(p_position_peak_state) <> 'object'
     or p_membership_version is null or p_membership_version < 0
     or p_state_version is null or p_state_version < 1
     or p_expected_state_version is null or p_expected_state_version < 0
     or p_state_version <> p_expected_state_version + 1
     or p_last_valuation_at is null
     or p_quote_source is null or nullif(trim(p_quote_source),'') is null
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_last_valuation_at > now() then
    raise exception 'Invalid portfolio protection state payload';
  end if;

  if array_position(p_included_position_ids, null) is not null
     or exists (
       select 1 from unnest(p_included_position_ids) as ids(position_id)
       where nullif(trim(position_id),'') is null
     )
     or cardinality(p_included_position_ids) <> (
       select count(distinct position_id)
       from unnest(p_included_position_ids) as ids(position_id)
     ) then
    raise exception 'Included position IDs must be unique and non-empty';
  end if;

  insert into public.portfolio_profit_protection_state (
    user_id, account_mode, broker, broker_account_ref,
    peak_unrealized_profit_usd, current_unrealized_profit_usd,
    protected_profit_floor_usd, protection_active, trailing_active,
    included_position_ids, position_peak_state, membership_version, state_version,
    last_valuation_at, quote_source, quote_as_of, updated_at
  )
  select
    p_user_id, p_account_mode, p_broker, p_broker_account_ref,
    p_peak_profit_usd, p_current_profit_usd,
    p_protected_floor_usd, p_trailing_active, p_trailing_active,
    p_included_position_ids, p_position_peak_state, p_membership_version, p_state_version,
    p_last_valuation_at, p_quote_source, p_quote_as_of, now()
  where p_expected_state_version = 0
  on conflict (user_id, broker, broker_account_ref, account_mode)
  do update set
    peak_unrealized_profit_usd = excluded.peak_unrealized_profit_usd,
    current_unrealized_profit_usd = excluded.current_unrealized_profit_usd,
    protected_profit_floor_usd = excluded.protected_profit_floor_usd,
    protection_active = excluded.protection_active,
    trailing_active = excluded.trailing_active,
    included_position_ids = excluded.included_position_ids,
    position_peak_state = excluded.position_peak_state,
    membership_version = excluded.membership_version,
    state_version = excluded.state_version,
    last_valuation_at = excluded.last_valuation_at,
    quote_source = excluded.quote_source,
    quote_as_of = excluded.quote_as_of,
    updated_at = now()
  where public.portfolio_profit_protection_state.state_version = p_expected_state_version
  returning true into v_saved;

  return coalesce(v_saved, false);
end;
$$;

revoke all on function public.save_portfolio_profit_protection_state_v2(
  uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.save_portfolio_profit_protection_state_v2(
  uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) to service_role;

comment on column public.portfolio_profit_protection_state.position_peak_state is
  'Per-position USD peak profit per unit and remaining units; updated atomically by the server-only portfolio monitor.';
comment on column public.portfolio_trade_permissions.close_manual_trades is
  'Separate explicit permission to close manual positions. Monitoring or inclusion permission alone never authorizes a close.';
comment on function public.save_portfolio_profit_protection_state_v2(
  uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap for account-scoped portfolio protection state.';
