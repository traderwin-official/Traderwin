-- Private server-only cache for latest verified Deriv ticks and scalping signal candidates.
create table if not exists public.scalping_market_ticks (
  instrument text primary key,
  provider_symbol text not null,
  quote numeric(24,10) not null check (quote > 0),
  bid numeric(24,10),
  ask numeric(24,10),
  quote_as_of timestamptz not null,
  received_at timestamptz not null,
  source text not null check (source = 'DERIV'),
  updated_at timestamptz not null default now(),
  constraint scalping_market_ticks_bid_ask_valid
    check ((bid is null or bid > 0) and (ask is null or ask > 0) and (bid is null or ask is null or ask >= bid))
);
alter table public.scalping_market_ticks enable row level security;
revoke all on public.scalping_market_ticks from anon, authenticated;
grant select, insert, update, delete on public.scalping_market_ticks to service_role;

create table if not exists public.scalping_signal_events (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  direction text not null check (direction in ('BUY','SELL')),
  confidence integer not null check (confidence between 0 and 100),
  entry numeric(24,10) not null check (entry > 0),
  stop_loss numeric(24,10) not null check (stop_loss > 0),
  take_profit numeric(24,10) not null check (take_profit > 0),
  risk_reward numeric(8,3) not null,
  reason text not null,
  indicators jsonb not null default '{}'::jsonb,
  source text not null check (source = 'DERIV'),
  signal_as_of timestamptz not null,
  candle_epoch bigint not null,
  status text not null default 'CANDIDATE' check (status in ('CANDIDATE','EXPIRED','REVIEWED')),
  created_at timestamptz not null default now(),
  unique (instrument,candle_epoch,direction)
);
alter table public.scalping_signal_events enable row level security;
revoke all on public.scalping_signal_events from anon, authenticated;
grant select, insert, update, delete on public.scalping_signal_events to service_role;

-- Server-managed, per-session DEMO scalping opt-in. No client role can enable it.
create table if not exists public.demo_scalping_preferences (
  session_id uuid primary key references public.demo_paper_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  account_mode text not null default 'DEMO' check (account_mode = 'DEMO'),
  execution text not null default 'WEBSITE_PAPER_ONLY' check (execution = 'WEBSITE_PAPER_ONLY'),
  max_risk_per_trade_pct numeric(5,2) not null default 0.25 check (max_risk_per_trade_pct > 0 and max_risk_per_trade_pct <= 0.25),
  max_daily_loss_pct numeric(5,2) not null default 1.00 check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 1.00),
  max_open_positions smallint not null default 1 check (max_open_positions between 1 and 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.demo_scalping_preferences enable row level security;
revoke all on public.demo_scalping_preferences from anon, authenticated;
grant select, insert, update, delete on public.demo_scalping_preferences to service_role;
