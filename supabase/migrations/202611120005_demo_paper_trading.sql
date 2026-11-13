-- DEMO-only paper ledger. No broker order endpoints.
create table if not exists public.demo_bot_sessions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 bot_setting_id uuid not null references public.bot_settings(id) on delete cascade,
 account_mode text not null default 'DEMO' check(account_mode='DEMO'),
 status text not null default 'STOPPED' check(status in('RUNNING','STOPPED','PAUSED','RISK_LOCKED')),
 virtual_currency text not null default 'USD' check(virtual_currency='USD'),
 starting_balance numeric(14,2) not null default 10000 check(starting_balance>0),
 current_balance numeric(14,2) not null default 10000 check(current_balance>=0),
 max_risk_per_trade_pct numeric(5,2) not null default 0.50 check(max_risk_per_trade_pct>0 and max_risk_per_trade_pct<=2),
 max_daily_loss_pct numeric(5,2) not null default 2.00 check(max_daily_loss_pct>0 and max_daily_loss_pct<=10),
 started_at timestamptz not null default now(), stopped_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists demo_bot_one_running_session_per_user on public.demo_bot_sessions(user_id) where status='RUNNING';
create index if not exists demo_bot_sessions_user_created_idx on public.demo_bot_sessions(user_id,created_at desc);
create table if not exists public.demo_bot_trades (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.demo_bot_sessions(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 symbol text not null,direction text not null check(direction in('BUY','SELL')),
 entry_price numeric(20,8) not null check(entry_price>0),
 stop_loss numeric(20,8) not null check(stop_loss>0),
 take_profit numeric(20,8) not null check(take_profit>0),
 virtual_units numeric(24,8) not null check(virtual_units>0),
 risk_amount numeric(14,2) not null check(risk_amount>0),
 risk_pct numeric(5,2) not null check(risk_pct>0 and risk_pct<=2),
 exit_price numeric(20,8),realized_pnl numeric(14,2),
 status text not null default 'OPEN' check(status in('OPEN','CLOSED','CANCELLED')),
 quote_source text not null check(quote_source in('DERIV','MT5','VERIFIED_DATA_PROVIDER')),
 quote_as_of timestamptz not null,
 opened_at timestamptz not null default now(),closed_at timestamptz,created_at timestamptz not null default now(),
 check((direction='BUY' and stop_loss<entry_price and take_profit>entry_price) or
       (direction='SELL' and stop_loss>entry_price and take_profit<entry_price))
);
create index if not exists demo_bot_trades_user_opened_idx on public.demo_bot_trades(user_id,opened_at desc);
create index if not exists demo_bot_trades_session_status_idx on public.demo_bot_trades(session_id,status);
alter table public.demo_bot_sessions enable row level security;
alter table public.demo_bot_trades enable row level security;
drop policy if exists "Users read own demo bot sessions" on public.demo_bot_sessions;
create policy "Users read own demo bot sessions" on public.demo_bot_sessions for select to authenticated using(auth.uid()=user_id);
drop policy if exists "Users read own demo bot trades" on public.demo_bot_trades;
create policy "Users read own demo bot trades" on public.demo_bot_trades for select to authenticated using(auth.uid()=user_id);
revoke all on public.demo_bot_sessions from anon,authenticated;
revoke all on public.demo_bot_trades from anon,authenticated;
grant select on public.demo_bot_sessions to authenticated;
grant select on public.demo_bot_trades to authenticated;
comment on table public.demo_bot_sessions is 'Virtual DEMO-only sessions. No broker connection or live orders.';
comment on table public.demo_bot_trades is 'Paper trades must use trusted, timestamped market data. Browser-supplied prices are not accepted.';
