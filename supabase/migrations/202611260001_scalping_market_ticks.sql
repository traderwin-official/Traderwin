-- Private, server-written latest-tick cache for the continuous DEMO scalping feed.
-- This table stores market data only; it never stores user credentials or orders.
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
