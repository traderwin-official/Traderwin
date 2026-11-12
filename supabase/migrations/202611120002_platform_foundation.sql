-- Traderwin platform foundation. Apply after 202611120001_trader_profiles.sql.
-- This creates safe product data structures only; it does not execute trades or collect payments.
create extension if not exists pgcrypto;

create table if not exists public.market_instruments(
 id uuid primary key default gen_random_uuid(),
 category text not null check(category in('FOREX','BINARY','CRYPTO','COMMODITIES','INDICES','STOCKS')),
 symbol text not null, display_name text not null, quote_currency text,
 enabled boolean not null default true, created_at timestamptz not null default now(),
 unique(category,symbol));
insert into public.market_instruments(category,symbol,display_name,quote_currency) values
('FOREX','EURUSD','Euro / US Dollar','USD'),('FOREX','GBPUSD','British Pound / US Dollar','USD'),
('FOREX','USDJPY','US Dollar / Japanese Yen','JPY'),('FOREX','AUDUSD','Australian Dollar / US Dollar','USD'),
('FOREX','USDCAD','US Dollar / Canadian Dollar','CAD'),('FOREX','USDCHF','US Dollar / Swiss Franc','CHF'),
('FOREX','NZDUSD','New Zealand Dollar / US Dollar','USD'),('FOREX','EURGBP','Euro / British Pound','GBP'),
('FOREX','GBPJPY','British Pound / Japanese Yen','JPY'),('FOREX','XAUUSD','Gold / US Dollar','USD'),
('BINARY','R_10','Deriv Volatility 10 Index',null),('BINARY','R_25','Deriv Volatility 25 Index',null),
('BINARY','R_50','Deriv Volatility 50 Index',null),('BINARY','R_75','Deriv Volatility 75 Index',null),
('BINARY','R_100','Deriv Volatility 100 Index',null),
('CRYPTO','BTCUSD','Bitcoin / US Dollar','USD'),('CRYPTO','ETHUSD','Ethereum / US Dollar','USD'),
('CRYPTO','SOLUSD','Solana / US Dollar','USD'),('CRYPTO','XRPUSD','XRP / US Dollar','USD'),
('COMMODITIES','XAGUSD','Silver / US Dollar','USD'),('COMMODITIES','USOIL','US Crude Oil','USD'),
('COMMODITIES','UKOIL','Brent Crude Oil','USD'),('INDICES','US500','US 500 Index','USD'),
('INDICES','NAS100','Nasdaq 100 Index','USD'),('INDICES','US30','Dow Jones 30','USD'),
('INDICES','GER40','Germany 40 Index','EUR'),('STOCKS','AAPL','Apple Inc.','USD'),
('STOCKS','MSFT','Microsoft Corp.','USD'),('STOCKS','NVDA','NVIDIA Corp.','USD'),
('STOCKS','TSLA','Tesla Inc.','USD')
on conflict(category,symbol) do update set display_name=excluded.display_name,quote_currency=excluded.quote_currency;
alter table public.market_instruments enable row level security;
drop policy if exists "Public reads enabled market instruments" on public.market_instruments;
create policy "Public reads enabled market instruments" on public.market_instruments for select using(enabled);
grant select on public.market_instruments to anon,authenticated;

create table if not exists public.bot_settings(
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade,
 broker text not null default 'Deriv', instrument text not null default 'XAUUSD',
 account_mode text not null default 'DEMO' check(account_mode in('DEMO','REAL')),
 enabled boolean not null default false, strategy text not null default 'MANUAL_REVIEW',
 max_risk_per_trade_pct numeric(5,2) not null default 0.50 check(max_risk_per_trade_pct>0 and max_risk_per_trade_pct<=2),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table public.bot_settings add column if not exists strategy text not null default 'MANUAL_REVIEW';
alter table public.bot_settings add column if not exists max_risk_per_trade_pct numeric(5,2) not null default 0.50;
alter table public.bot_settings add column if not exists updated_at timestamptz not null default now();
alter table public.bot_settings enable row level security;
drop policy if exists "Users manage own bot settings" on public.bot_settings;
create policy "Users manage own bot settings" on public.bot_settings for all to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
revoke all on public.bot_settings from anon,authenticated;
grant select on public.bot_settings to authenticated;
grant insert(user_id,broker,instrument,account_mode,strategy,max_risk_per_trade_pct)
 on public.bot_settings to authenticated;
grant update(broker,instrument,account_mode,strategy,max_risk_per_trade_pct)
 on public.bot_settings to authenticated;

create table if not exists public.broker_connections(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check(provider in('DERIV','MT5')),external_account_id text,account_label text,
 account_mode text not null default 'DEMO' check(account_mode in('DEMO','REAL')),
 connection_status text not null default 'PENDING' check(connection_status in('PENDING','CONNECTED','DISCONNECTED','ERROR')),
 verified_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,provider,external_account_id));
alter table public.broker_connections enable row level security;
drop policy if exists "Users read own broker connection metadata" on public.broker_connections;
create policy "Users read own broker connection metadata" on public.broker_connections for select to authenticated using(auth.uid()=user_id);
drop policy if exists "Users create own broker connection metadata" on public.broker_connections;
create policy "Users create own broker connection metadata" on public.broker_connections for insert to authenticated with check(auth.uid()=user_id);
drop policy if exists "Users update own broker connection metadata" on public.broker_connections;
create policy "Users update own broker connection metadata" on public.broker_connections for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
revoke all on public.broker_connections from anon,authenticated;
grant select on public.broker_connections to authenticated;
grant insert(user_id,provider,external_account_id,account_label,account_mode)
 on public.broker_connections to authenticated;
grant update(account_label,account_mode) on public.broker_connections to authenticated;
comment on table public.broker_connections is 'Metadata only. OAuth tokens must remain encrypted server-side.';

create table if not exists public.trading_signals(
 id uuid primary key default gen_random_uuid(),market_category text not null default 'FOREX'
 check(market_category in('FOREX','BINARY','CRYPTO','COMMODITIES','INDICES','STOCKS')),
 symbol text not null,direction text not null check(direction in('BUY','SELL','UP','DOWN','WAIT')),
 timeframe text not null default 'M15',entry_price numeric,stop_loss numeric,take_profit_1 numeric,
 take_profit_2 numeric,take_profit_3 numeric,confidence_score numeric(5,2) check(confidence_score between 0 and 100),
 status text not null default 'DRAFT' check(status in('DRAFT','PENDING_REVIEW','ACTIVE','CLOSED','CANCELLED')),
 rationale text,source_name text,source_url text,source_timestamp timestamptz,reviewed_by uuid references auth.users(id),
 published_at timestamptz,expires_at timestamptz,created_by uuid references auth.users(id),created_at timestamptz not null default now());
alter table public.trading_signals add column if not exists market_category text not null default 'FOREX';
alter table public.trading_signals enable row level security;
drop policy if exists "Anyone reads active unexpired signals" on public.trading_signals;
create policy "Anyone reads active unexpired signals" on public.trading_signals for select using(status='ACTIVE' and (expires_at is null or expires_at>now()));
grant select on public.trading_signals to anon,authenticated;

create table if not exists public.ai_trade_ideas(
 id uuid primary key default gen_random_uuid(),market_category text not null check(market_category in('FOREX','BINARY','CRYPTO','COMMODITIES','INDICES','STOCKS')),
 symbol text not null,direction text not null check(direction in('BUY','SELL','UP','DOWN','WAIT')),timeframe text not null,
 entry_zone jsonb,stop_loss numeric,take_profits jsonb,confidence_score numeric(5,2) check(confidence_score between 0 and 100),
 risk_reward numeric(8,3),analysis text not null,evidence jsonb not null default '[]'::jsonb,
 source_timestamp timestamptz,generated_at timestamptz not null default now(),stale_after timestamptz,
 review_status text not null default 'PENDING_REVIEW' check(review_status in('PENDING_REVIEW','APPROVED','REJECTED','EXPIRED')),
 reviewed_by uuid references auth.users(id),reviewed_at timestamptz);
alter table public.ai_trade_ideas enable row level security;
drop policy if exists "Users read approved fresh AI ideas" on public.ai_trade_ideas;
create policy "Users read approved fresh AI ideas" on public.ai_trade_ideas for select to authenticated using(review_status='APPROVED' and (stale_after is null or stale_after>now()));
grant select on public.ai_trade_ideas to authenticated;
comment on table public.ai_trade_ideas is 'Research records only; require provenance, freshness checks and human approval.';

create table if not exists public.bot_activity(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 bot_setting_id uuid references public.bot_settings(id) on delete set null,
 event_type text not null check(event_type in('CONFIG_SAVED','START_REQUESTED','STOP_REQUESTED','RISK_BLOCK','DEMO_ORDER','ERROR')),
 account_mode text not null default 'DEMO' check(account_mode in('DEMO','REAL')),details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now());
alter table public.bot_activity enable row level security;
drop policy if exists "Users read own bot activity" on public.bot_activity;
create policy "Users read own bot activity" on public.bot_activity for select to authenticated using(auth.uid()=user_id);
grant select on public.bot_activity to authenticated;

create table if not exists public.traderwin_admin_roles(
 user_id uuid primary key references auth.users(id) on delete cascade,role text not null check(role in('ADMIN','SUPPORT','ANALYST')),
 granted_at timestamptz not null default now(),granted_by uuid references auth.users(id));
alter table public.traderwin_admin_roles enable row level security;
drop policy if exists "Users read own admin role" on public.traderwin_admin_roles;
create policy "Users read own admin role" on public.traderwin_admin_roles for select to authenticated using(auth.uid()=user_id);
grant select on public.traderwin_admin_roles to authenticated;

create table if not exists public.service_catalog(
 id uuid primary key default gen_random_uuid(),service_code text not null unique,service_name text not null,
 description text,price_kes numeric(12,2) not null check(price_kes>=0),
 billing_period text not null default 'ONE_TIME' check(billing_period in('ONE_TIME','MONTHLY','YEARLY')),
 active boolean not null default true,created_at timestamptz not null default now());
insert into public.service_catalog(service_code,service_name,description,price_kes,billing_period) values
('MEMBERSHIP','Traderwin Membership','Platform membership access',0,'MONTHLY'),
('EDUCATION','Trading Education','Courses and learning materials',0,'ONE_TIME'),
('SIGNALS','Premium Signals','Reviewed market research',0,'MONTHLY'),
('ADVANCED_BOT','Advanced Bot','Advanced automation tools',0,'MONTHLY')
on conflict(service_code) do nothing;

create table if not exists public.payment_orders(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 service_code text not null references public.service_catalog(service_code),amount_kes numeric(12,2) not null check(amount_kes>0),
 currency text not null default 'KES' check(currency='KES'),payment_method text not null default 'MPESA' check(payment_method='MPESA'),
 phone_number text,provider_reference text unique,checkout_request_id text unique,
 status text not null default 'PENDING' check(status in('PENDING','PAID','FAILED','CANCELLED','REFUNDED')),
 confirmed_at timestamptz,created_at timestamptz not null default now());
alter table public.payment_orders enable row level security;
drop policy if exists "Users read own payment orders" on public.payment_orders;
create policy "Users read own payment orders" on public.payment_orders for select to authenticated using(auth.uid()=user_id);
grant select on public.payment_orders to authenticated;

create table if not exists public.user_subscriptions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 service_code text not null references public.service_catalog(service_code),
 status text not null default 'PENDING' check(status in('PENDING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
 starts_at timestamptz,ends_at timestamptz,payment_order_id uuid references public.payment_orders(id),
 created_at timestamptz not null default now(),unique(user_id,service_code));
alter table public.user_subscriptions enable row level security;
drop policy if exists "Users read own subscriptions" on public.user_subscriptions;
create policy "Users read own subscriptions" on public.user_subscriptions for select to authenticated using(auth.uid()=user_id);
grant select on public.user_subscriptions to authenticated;

create table if not exists public.education_courses(
 id uuid primary key default gen_random_uuid(),title text not null,description text,
 level text not null default 'BEGINNER' check(level in('BEGINNER','INTERMEDIATE','ADVANCED')),
 price_kes numeric(12,2) not null default 0 check(price_kes>=0),published boolean not null default false,
 created_at timestamptz not null default now());
alter table public.education_courses enable row level security;
drop policy if exists "Public reads published courses" on public.education_courses;
create policy "Public reads published courses" on public.education_courses for select using(published);
grant select on public.education_courses to anon,authenticated;

create table if not exists public.course_enrolments(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 course_id uuid not null references public.education_courses(id) on delete cascade,
 payment_order_id uuid references public.payment_orders(id),
 status text not null default 'PENDING' check(status in('PENDING','ACTIVE','COMPLETED','REVOKED')),
 enrolled_at timestamptz not null default now(),unique(user_id,course_id));
alter table public.course_enrolments enable row level security;
drop policy if exists "Users read own course enrolments" on public.course_enrolments;
create policy "Users read own course enrolments" on public.course_enrolments for select to authenticated using(auth.uid()=user_id);
grant select on public.course_enrolments to authenticated;

create or replace function public.traderwin_platform_touch_updated_at()
returns trigger language plpgsql set search_path=public as $$ begin new.updated_at=now(); return new; end; $$;
drop trigger if exists bot_settings_touch_updated_at on public.bot_settings;
create trigger bot_settings_touch_updated_at before update on public.bot_settings for each row execute function public.traderwin_platform_touch_updated_at();
drop trigger if exists broker_connections_touch_updated_at on public.broker_connections;
create trigger broker_connections_touch_updated_at before update on public.broker_connections for each row execute function public.traderwin_platform_touch_updated_at();

-- No browser write grants on payment status, admin roles, AI approval, or live-trading controls.
comment on table public.payment_orders is 'Read-only for clients; trusted payment callbacks alone may confirm payments.';
comment on table public.bot_activity is 'Audit ledger only. It is not a trading execution engine.';
