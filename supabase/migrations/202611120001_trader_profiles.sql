-- Traderwin core account-mode foundation
-- Apply this migration in Supabase SQL Editor before deploying UI code that uses trader_profiles.
-- REAL mode is a preference only. Client-side users cannot enable live execution.

create table if not exists public.trader_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_mode text not null default 'DEMO' check (account_mode in ('DEMO', 'REAL')),
  real_trading_enabled boolean not null default false,
  real_risk_acknowledged_at timestamptz,
  max_risk_per_trade_pct numeric(5,2) not null default 0.50
    check (max_risk_per_trade_pct > 0 and max_risk_per_trade_pct <= 2.00),
  max_daily_loss_pct numeric(5,2) not null default 2.00
    check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 10.00),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trading_mode_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  previous_mode text,
  new_mode text not null check (new_mode in ('DEMO', 'REAL')),
  changed_at timestamptz not null default now()
);
create index if not exists trading_mode_audit_user_changed_idx
  on public.trading_mode_audit (user_id, changed_at desc);

alter table public.trader_profiles enable row level security;
alter table public.trading_mode_audit enable row level security;

drop policy if exists "Users can read their own trader profile" on public.trader_profiles;
create policy "Users can read their own trader profile" on public.trader_profiles
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can create their own trader profile" on public.trader_profiles;
create policy "Users can create their own trader profile" on public.trader_profiles
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users can update their own trader profile" on public.trader_profiles;
create policy "Users can update their own trader profile" on public.trader_profiles
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can read their own trading mode audit" on public.trading_mode_audit;
create policy "Users can read their own trading mode audit" on public.trading_mode_audit
  for select to authenticated using (auth.uid() = user_id);

-- Browser clients cannot set real_trading_enabled.
revoke all on public.trader_profiles from anon, authenticated;
grant select on public.trader_profiles to authenticated;
grant insert (user_id, account_mode, real_risk_acknowledged_at,
              max_risk_per_trade_pct, max_daily_loss_pct)
  on public.trader_profiles to authenticated;
grant update (account_mode, real_risk_acknowledged_at,
              max_risk_per_trade_pct, max_daily_loss_pct)
  on public.trader_profiles to authenticated;
revoke all on public.trading_mode_audit from anon, authenticated;
grant select on public.trading_mode_audit to authenticated;

create or replace function public.traderwin_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trader_profiles_set_updated_at on public.trader_profiles;
create trigger trader_profiles_set_updated_at before update on public.trader_profiles
  for each row execute function public.traderwin_set_updated_at();

create or replace function public.traderwin_audit_account_mode()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.trading_mode_audit (user_id, previous_mode, new_mode)
    values (new.user_id, null, new.account_mode);
  elsif old.account_mode is distinct from new.account_mode then
    insert into public.trading_mode_audit (user_id, previous_mode, new_mode)
    values (new.user_id, old.account_mode, new.account_mode);
  end if;
  return new;
end;
$$;
drop trigger if exists trader_profiles_audit_mode on public.trader_profiles;
create trigger trader_profiles_audit_mode after insert or update of account_mode
  on public.trader_profiles for each row execute function public.traderwin_audit_account_mode();

comment on column public.trader_profiles.real_trading_enabled is
  'Server-controlled safety gate. Browser clients cannot insert or update this column.';
comment on table public.trader_profiles is
  'Per-user account mode and risk preferences. REAL selection does not authorize live orders.';
