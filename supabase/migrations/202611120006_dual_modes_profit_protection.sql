-- Separate per-mode preferences. Real order authorization remains server-only.
create table if not exists public.bot_mode_profiles(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 account_mode text not null check(account_mode in('DEMO','REAL')),broker text not null default 'Deriv',
 instrument text not null default 'XAUUSD',strategy text not null default 'MULTI_CONFIRMATION_V1',
 max_risk_per_trade_pct numeric(5,2) not null default .50 check(max_risk_per_trade_pct>0 and max_risk_per_trade_pct<=2),
 max_daily_loss_pct numeric(5,2) not null default 2 check(max_daily_loss_pct>0 and max_daily_loss_pct<=10),
 profit_giveback_pct numeric(5,2) not null default 20 check(profit_giveback_pct>0 and profit_giveback_pct<100),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,account_mode));
insert into public.bot_mode_profiles(user_id,account_mode,broker,instrument,strategy,max_risk_per_trade_pct,max_daily_loss_pct)
select p.user_id,m.mode,coalesce(b.broker,'Deriv'),coalesce(b.instrument,'XAUUSD'),'MULTI_CONFIRMATION_V1',p.max_risk_per_trade_pct,p.max_daily_loss_pct
from public.trader_profiles p cross join (values('DEMO'),('REAL')) m(mode) left join public.bot_settings b on b.user_id=p.user_id
on conflict(user_id,account_mode) do nothing;
alter table public.bot_mode_profiles enable row level security;
drop policy if exists "Users read own mode profiles" on public.bot_mode_profiles;
create policy "Users read own mode profiles" on public.bot_mode_profiles for select to authenticated using(auth.uid()=user_id);
drop policy if exists "Users insert own mode profiles" on public.bot_mode_profiles;
create policy "Users insert own mode profiles" on public.bot_mode_profiles for insert to authenticated with check(auth.uid()=user_id);
drop policy if exists "Users update own mode profiles" on public.bot_mode_profiles;
create policy "Users update own mode profiles" on public.bot_mode_profiles for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
revoke all on public.bot_mode_profiles from anon,authenticated;
grant select on public.bot_mode_profiles to authenticated;
grant insert(user_id,account_mode,broker,instrument,strategy,max_risk_per_trade_pct,max_daily_loss_pct,profit_giveback_pct) on public.bot_mode_profiles to authenticated;
grant update(broker,instrument,strategy,max_risk_per_trade_pct,max_daily_loss_pct,profit_giveback_pct) on public.bot_mode_profiles to authenticated;
create table if not exists public.real_execution_authorizations(
 user_id uuid primary key references auth.users(id) on delete cascade,
 status text not null default 'LOCKED' check(status in('LOCKED','PENDING_REVIEW','AUTHORIZED','REVOKED')),
 risk_acknowledged_at timestamptz,broker_verified_at timestamptz,authorized_at timestamptz,
 authorized_by uuid references auth.users(id),revoked_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now());
alter table public.real_execution_authorizations enable row level security;
revoke all on public.real_execution_authorizations from anon,authenticated;
comment on table public.real_execution_authorizations is 'Server-only live execution authorization. Browser users cannot grant themselves permission.';
alter table public.demo_bot_trades add column if not exists peak_unrealized_profit numeric(14,2) not null default 0;
alter table public.demo_bot_trades add column if not exists profit_giveback_pct numeric(5,2) not null default 20 check(profit_giveback_pct>0 and profit_giveback_pct<100);
alter table public.demo_bot_trades add column if not exists protected_stop_price numeric(20,8);
alter table public.demo_bot_trades add column if not exists last_mark_price numeric(20,8);
alter table public.demo_bot_trades add column if not exists last_mark_at timestamptz;
create index if not exists demo_bot_trades_open_user_idx on public.demo_bot_trades(user_id,status);
