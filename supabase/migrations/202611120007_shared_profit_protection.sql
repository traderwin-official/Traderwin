-- Shared profit-protection policy for DEMO and REAL trade managers.
-- This migration creates risk-state records only; it does not send broker orders.
alter table public.trader_profiles
 add column if not exists profit_giveback_pct numeric(5,2) not null default 20.00
 check(profit_giveback_pct>0 and profit_giveback_pct<=50.00),
 add column if not exists trailing_profit_protection boolean not null default true;

grant update(profit_giveback_pct,trailing_profit_protection)
 on public.trader_profiles to authenticated;

alter table public.demo_bot_trades
 add column if not exists peak_unrealized_profit numeric(14,2) not null default 0,
 add column if not exists protected_profit_floor numeric(14,2) not null default 0,
 add column if not exists profit_trailing_active boolean not null default false,
 add column if not exists last_mark_price numeric(20,8),
 add column if not exists last_marked_at timestamptz;

create table if not exists public.live_trade_risk_state (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 broker text not null check(broker in('DERIV','MT5')),
 broker_account_ref text not null,
 broker_position_ref text not null,
 symbol text not null,
 direction text not null check(direction in('BUY','SELL')),
 entry_price numeric(20,8) not null check(entry_price>0),
 initial_stop_loss numeric(20,8) not null check(initial_stop_loss>0),
 current_protective_stop numeric(20,8),
 peak_unrealized_profit numeric(14,2) not null default 0,
 protected_profit_floor numeric(14,2) not null default 0,
 profit_giveback_pct numeric(5,2) not null default 20 check(profit_giveback_pct>0 and profit_giveback_pct<=50),
 trailing_active boolean not null default false,
 broker_position_status text not null default 'OPEN' check(broker_position_status in('OPEN','CLOSING','CLOSED','ERROR')),
 last_broker_sync_at timestamptz,
 last_price_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(broker,broker_account_ref,broker_position_ref)
);
create index if not exists live_trade_risk_state_user_idx on public.live_trade_risk_state(user_id,broker_position_status);
alter table public.live_trade_risk_state enable row level security;
revoke all on public.live_trade_risk_state from anon,authenticated;
comment on table public.live_trade_risk_state is 'Server-only risk tracking metadata for broker positions. No broker tokens. A live adapter must verify each stop update/close at the broker.';
comment on column public.trader_profiles.profit_giveback_pct is 'Default 20 means close when current open profit falls 20 percent from its recorded peak, subject to executable broker pricing and slippage.';
