-- Consolidated additive schema upgrade for the Young Tiger website DEMO terminal.
-- Prepared from the reviewed branch migrations. Run once in Supabase SQL Editor.
-- This does not modify legacy demo_bot_* tables or enable REAL execution.
-- Prerequisites: existing public.trader_profiles, public.bot_settings and public.portfolio_profit_protection_state.
begin;

do $ begin
  if to_regclass('public.trader_profiles') is null then raise exception 'Prerequisite missing: public.trader_profiles'; end if;
  if to_regclass('public.bot_settings') is null then raise exception 'Prerequisite missing: public.bot_settings'; end if;
  if to_regclass('public.portfolio_profit_protection_state') is null then raise exception 'Prerequisite missing: public.portfolio_profit_protection_state'; end if;
end $;

-- 0. Persist the selected timeframe used by automated DEMO sessions.
-- This is additive: existing bot preferences and risk settings remain unchanged.
alter table public.bot_settings
  add column if not exists timeframe text not null default 'M15';

do $ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bot_settings'::regclass
       and conname = 'bot_settings_timeframe_check'
  ) then
    alter table public.bot_settings
      add constraint bot_settings_timeframe_check
      check (timeframe in ('M5','M15','H1','H4'));
  end if;
end $;

grant insert(user_id,broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;
grant update(broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;

-- 1. Admin role registry required for controlled platform administration.
create table if not exists public.traderwin_admin_roles(
 user_id uuid primary key references auth.users(id) on delete cascade,role text not null check(role in('ADMIN','SUPPORT','ANALYST')),
 granted_at timestamptz not null default now(),granted_by uuid references auth.users(id));
alter table public.traderwin_admin_roles enable row level security;
drop policy if exists "Users read own admin role" on public.traderwin_admin_roles;
create policy "Users read own admin role" on public.traderwin_admin_roles for select to authenticated using(auth.uid()=user_id);
grant select on public.traderwin_admin_roles to authenticated;


-- 2. Existing account-level emergency stop consulted by DEMO APIs.
-- Per-account emergency stop latch. It halts new bot entries; it is not an order-close command.
-- Broker/account execution adapters must still reconcile positions and independently verify protective stops.
create table if not exists public.bot_emergency_controls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_mode text not null check (account_mode in ('DEMO','REAL')),
  broker text not null check (broker in ('DERIV','MT5')),
  broker_account_ref text not null check (length(trim(broker_account_ref)) between 1 and 200),
  kill_switch_active boolean not null default false,
  reason text,
  changed_at timestamptz not null default now(),
  unique (user_id, account_mode, broker, broker_account_ref)
);
alter table public.bot_emergency_controls enable row level security;
revoke all on public.bot_emergency_controls from public, anon, authenticated;
comment on table public.bot_emergency_controls is
  'Server-controlled per-user/account emergency entry-stop latch. It does not close positions or grant close permission. Service role only.';

-- 3. Isolated website DEMO paper ledger, sessions, trades and core RPCs.
-- Additive v2 DEMO paper ledger. Existing demo_bot_* production tables are untouched.
create table if not exists public.demo_paper_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker = 'DERIV'),
  broker_account_ref text not null,
  instrument text not null,
  strategy text not null,
  timeframe text not null check (timeframe in ('M5','M15','H1','H4')),
  status text not null default 'RUNNING' check (status in ('RUNNING','PAUSED','STOPPED','RISK_LOCKED')),
  virtual_currency text not null default 'USD' check (virtual_currency = 'USD'),
  starting_balance numeric(18,2) not null default 10000 check (starting_balance > 0),
  current_balance numeric(18,2) not null default 10000 check (current_balance >= 0),
  risk_per_trade_pct numeric(5,2) not null default 0.50 check (risk_per_trade_pct > 0 and risk_per_trade_pct <= 2),
  max_daily_loss_pct numeric(5,2) not null default 2.00 check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 10),
  config_snapshot jsonb not null default '{}'::jsonb,
  last_candle_as_of timestamptz,
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.demo_paper_sessions add column if not exists risk_locked_at timestamptz;
create unique index if not exists demo_paper_one_active_session_per_user
  on public.demo_paper_sessions(user_id) where status in ('RUNNING','PAUSED','RISK_LOCKED');
create index if not exists demo_paper_sessions_queue_idx
  on public.demo_paper_sessions(status,updated_at);

create table if not exists public.demo_paper_trades (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument text not null,
  side text not null check (side in ('BUY','SELL')),
  entry_price numeric(24,10) not null check (entry_price > 0),
  stop_loss numeric(24,10) not null check (stop_loss > 0),
  take_profit numeric(24,10) not null check (take_profit > 0),
  tp1_price numeric(24,10), tp2_price numeric(24,10), tp3_price numeric(24,10),
  tp1_done boolean not null default false, tp2_done boolean not null default false, tp3_done boolean not null default false,
  quantity numeric(28,12) not null check (quantity > 0),
  remaining_quantity numeric(28,12) not null check (remaining_quantity >= 0),
  risk_amount_usd numeric(18,2) not null check (risk_amount_usd > 0),
  risk_pct numeric(5,2) not null check (risk_pct > 0 and risk_pct <= 2),
  quote_to_usd numeric(24,12) not null check (quote_to_usd > 0),
  quote_source text not null check (quote_source = 'DERIV'),
  quote_as_of timestamptz not null,
  candle_as_of timestamptz,
  trade_origin text not null check (trade_origin in ('BOT','MANUAL')),
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  last_mark_price numeric(24,10),
  last_mark_at timestamptz,
  realized_pnl_usd numeric(18,2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((side='BUY' and stop_loss<entry_price and take_profit>entry_price) or
         (side='SELL' and stop_loss>entry_price and take_profit<entry_price)),
  check ((status='OPEN' and remaining_quantity>0) or (status='CLOSED' and remaining_quantity=0))
);
create unique index if not exists demo_paper_one_open_trade_per_session
  on public.demo_paper_trades(session_id) where status='OPEN';
create unique index if not exists demo_paper_one_open_trade_per_user
  on public.demo_paper_trades(user_id) where status='OPEN';
create index if not exists demo_paper_trades_user_status_idx
  on public.demo_paper_trades(user_id,status,opened_at desc);

create table if not exists public.demo_paper_worker_heartbeats (
  session_id uuid primary key references public.demo_paper_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_tick_at timestamptz not null,
  last_action text,
  last_reason text,
  last_error text,
  updated_at timestamptz not null default now()
);
create table if not exists public.demo_paper_worker_leases (
  lease_key text primary key default 'global',
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.demo_paper_worker_leases(lease_key) values ('global') on conflict do nothing;

create table if not exists public.demo_paper_emergency_controls (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null default 'DERIV' check (broker='DERIV'),
  broker_account_ref text not null,
  entries_blocked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(user_id,broker,broker_account_ref)
);

alter table public.demo_paper_sessions enable row level security;
alter table public.demo_paper_trades enable row level security;
alter table public.demo_paper_worker_heartbeats enable row level security;
alter table public.demo_paper_worker_leases enable row level security;
alter table public.demo_paper_emergency_controls enable row level security;
drop policy if exists demo_paper_sessions_owner_read on public.demo_paper_sessions;
create policy demo_paper_sessions_owner_read on public.demo_paper_sessions for select to authenticated using (auth.uid()=user_id);
drop policy if exists demo_paper_trades_owner_read on public.demo_paper_trades;
create policy demo_paper_trades_owner_read on public.demo_paper_trades for select to authenticated using (auth.uid()=user_id);
drop policy if exists demo_paper_heartbeats_owner_read on public.demo_paper_worker_heartbeats;
create policy demo_paper_heartbeats_owner_read on public.demo_paper_worker_heartbeats for select to authenticated using (auth.uid()=user_id);
revoke all on public.demo_paper_sessions,public.demo_paper_trades,public.demo_paper_worker_heartbeats,
  public.demo_paper_worker_leases,public.demo_paper_emergency_controls from anon,authenticated;
grant select on public.demo_paper_sessions,public.demo_paper_trades,public.demo_paper_worker_heartbeats to authenticated;
grant all on public.demo_paper_sessions,public.demo_paper_trades,public.demo_paper_worker_heartbeats,public.demo_paper_worker_leases,public.demo_paper_emergency_controls to service_role;

create or replace function public.claim_demo_paper_worker(p_token uuid,p_lease_seconds integer default 90)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_claimed integer;
begin
 if auth.role() <> 'service_role' or p_token is null or p_lease_seconds not between 15 and 180 then
   raise exception 'Unauthorized or invalid worker lease';
 end if;
 insert into public.demo_paper_worker_leases(lease_key) values('global') on conflict do nothing;
 update public.demo_paper_worker_leases
    set lease_token=p_token,lease_until=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where lease_key='global' and (lease_until is null or lease_until < now() or lease_token=p_token);
 get diagnostics v_claimed = row_count;
 return v_claimed=1;
end $$;

create or replace function public.release_demo_paper_worker(p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
 if auth.role() <> 'service_role' or p_token is null then raise exception 'Unauthorized'; end if;
 update public.demo_paper_worker_leases set lease_token=null,lease_until=null,updated_at=now()
  where lease_key='global' and lease_token=p_token;
 get diagnostics v_count = row_count;
 return v_count=1;
end $$;

create or replace function public.open_demo_paper_trade(
 p_user_id uuid,p_session_id uuid,p_instrument text,p_side text,p_entry numeric,p_stop numeric,p_target numeric,
 p_quantity numeric,p_risk_amount numeric,p_risk_pct numeric,p_quote_to_usd numeric,
 p_quote_source text,p_quote_as_of timestamptz,p_trade_origin text default 'MANUAL',
 p_candle_as_of timestamptz default null,p_tp1 numeric default null,p_tp2 numeric default null,p_tp3 numeric default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.demo_paper_sessions%rowtype; v_id uuid; v_daily_loss numeric;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if p_user_id is null or p_session_id is null or p_instrument is null or p_side not in('BUY','SELL')
   or p_entry<=0 or p_stop<=0 or p_target<=0 or p_quantity<=0 or p_risk_amount<=0
   or p_risk_pct<=0 or p_risk_pct>2 or p_quote_to_usd<=0 or p_quote_source<>'DERIV'
   or p_quote_as_of is null or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
   or p_trade_origin not in('BOT','MANUAL') then raise exception 'Invalid or stale paper trade'; end if;
 select * into v_session from public.demo_paper_sessions where id=p_session_id and user_id=p_user_id for update;
 if not found or v_session.status<>'RUNNING' then return jsonb_build_object('ok',false,'reason','SESSION_NOT_RUNNING'); end if;
 if upper(v_session.instrument)<>upper(p_instrument) then return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH'); end if;
 if not ((p_side='BUY' and p_stop<p_entry and p_target>p_entry) or (p_side='SELL' and p_stop>p_entry and p_target<p_entry)) then
   raise exception 'Invalid stop/target placement'; end if;
 if exists(select 1 from public.demo_paper_emergency_controls e where e.user_id=p_user_id and e.broker='DERIV'
   and e.broker_account_ref=v_session.broker_account_ref and e.entries_blocked) then
   return jsonb_build_object('ok',false,'reason','KILL_SWITCH_ACTIVE'); end if;
 if p_risk_pct>v_session.risk_per_trade_pct or p_risk_amount>v_session.current_balance*v_session.risk_per_trade_pct/100
   or abs(p_risk_amount-abs(p_entry-p_stop)*p_quantity*p_quote_to_usd)>0.02 then
   raise exception 'Paper position risk does not match the server-approved session limits'; end if;
 if exists(select 1 from public.demo_paper_trades t where t.user_id=p_user_id and t.status='OPEN') then
   return jsonb_build_object('ok',false,'reason','OPEN_POSITION_EXISTS'); end if;
 v_daily_loss := greatest(0, -coalesce((select sum(realized_pnl_usd) from public.demo_paper_trades
   where user_id=p_user_id and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'),0));
 if v_daily_loss >= v_session.starting_balance*v_session.max_daily_loss_pct/100 then
   update public.demo_paper_sessions set status='RISK_LOCKED',risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now() where id=p_session_id;
   return jsonb_build_object('ok',false,'reason','DAILY_LOSS_LIMIT'); end if;
 insert into public.demo_paper_trades(session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
   tp1_price,tp2_price,tp3_price,quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
   quote_source,quote_as_of,candle_as_of,trade_origin)
 values(p_session_id,p_user_id,p_instrument,p_side,p_entry,p_stop,p_target,p_tp1,p_tp2,p_tp3,
   p_quantity,p_quantity,p_risk_amount,p_risk_pct,p_quote_to_usd,p_quote_source,p_quote_as_of,p_candle_as_of,p_trade_origin)
 returning id into v_id;
 update public.demo_paper_sessions set last_candle_as_of=coalesce(p_candle_as_of,last_candle_as_of),updated_at=now() where id=p_session_id;
 return jsonb_build_object('ok',true,'trade_id',v_id,'status','OPEN','instrument',p_instrument,'side',p_side,
   'entry_price',p_entry,'stop_loss',p_stop,'take_profit',p_target,'quantity',p_quantity,'risk_amount_usd',p_risk_amount,'risk_pct',p_risk_pct,'opened_at',now());
end $$;

create or replace function public.close_demo_paper_trade(
 p_user_id uuid,p_trade_id uuid,p_exit_price numeric,p_quote_to_usd numeric,
 p_quote_source text,p_quote_as_of timestamptz,p_reason text default 'MANUAL_CLOSE'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_trade public.demo_paper_trades%rowtype; v_pnl numeric(18,2); v_balance numeric(18,2);
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if p_exit_price<=0 or p_quote_to_usd<=0 or p_quote_source<>'DERIV' or p_quote_as_of is null
   or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds' then raise exception 'Invalid or stale close quote'; end if;
 select * into v_trade from public.demo_paper_trades where id=p_trade_id and user_id=p_user_id and status='OPEN' for update;
 if not found then return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN'); end if;
 if v_trade.trade_origin='BOT' and p_reason='MANUAL_CLOSE' then null; end if;
 v_pnl := round((case when v_trade.side='BUY' then p_exit_price-v_trade.entry_price else v_trade.entry_price-p_exit_price end)
   *v_trade.remaining_quantity*p_quote_to_usd,2);
 update public.demo_paper_trades set status='CLOSED',remaining_quantity=0,last_mark_price=p_exit_price,
   last_mark_at=p_quote_as_of,realized_pnl_usd=realized_pnl_usd+v_pnl,closed_at=now() where id=v_trade.id;
 update public.demo_paper_sessions set current_balance=greatest(0,current_balance+v_pnl),
   status=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades
      where user_id=p_user_id and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi')) >= starting_balance*max_daily_loss_pct/100 then 'RISK_LOCKED' else status end,
   risk_locked_at=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades where user_id=p_user_id and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi')) >= starting_balance*max_daily_loss_pct/100 then coalesce(risk_locked_at,now()) else risk_locked_at end,
   updated_at=now() where id=v_trade.session_id returning current_balance into v_balance;
 return jsonb_build_object('ok',true,'trade_id',v_trade.id,'exit_price',p_exit_price,
   'realized_pnl_total',v_pnl,'realized_pnl_this_stage',v_pnl,'balance',v_balance);
end $$;

create or replace function public.mark_demo_paper_trade(
 p_user_id uuid,p_trade_id uuid,p_price numeric,p_quote_as_of timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.role()<>'service_role' or p_price<=0 or p_quote_as_of is null or p_quote_as_of>now()
   or p_quote_as_of<now()-interval '30 seconds' then raise exception 'Unauthorized or stale mark'; end if;
 update public.demo_paper_trades set last_mark_price=p_price,last_mark_at=p_quote_as_of
  where id=p_trade_id and user_id=p_user_id and status='OPEN';
 return found;
end $$;


create or replace function public.manage_demo_paper_exit(
 p_user_id uuid,p_trade_id uuid,p_stage text,p_exit_price numeric,p_quote_to_usd numeric,
 p_quote_source text,p_quote_as_of timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_trade public.demo_paper_trades%rowtype; v_qty numeric(28,12); v_pnl numeric(18,2);
 v_remaining numeric(28,12); v_closed boolean; v_balance numeric(18,2);
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if p_stage not in('TP1','TP2','TP3','STOP_LOSS') or p_exit_price<=0 or p_quote_to_usd<=0
   or p_quote_source<>'DERIV' or p_quote_as_of is null or p_quote_as_of>now()
   or p_quote_as_of<now()-interval '30 seconds' then raise exception 'Invalid or stale exit'; end if;
 select * into v_trade from public.demo_paper_trades
  where id=p_trade_id and user_id=p_user_id and status='OPEN' for update;
 if not found then return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN'); end if;
 if v_trade.trade_origin<>'BOT' then return jsonb_build_object('ok',false,'reason','MANUAL_TRADE_NOT_MANAGED'); end if;
 if p_stage='TP1' then
   if v_trade.tp1_done or v_trade.tp1_price is null or
     not ((v_trade.side='BUY' and p_exit_price>=v_trade.tp1_price) or (v_trade.side='SELL' and p_exit_price<=v_trade.tp1_price))
     then return jsonb_build_object('ok',false,'reason','TP1_NOT_REACHED'); end if;
   v_qty:=least(v_trade.remaining_quantity,v_trade.quantity*0.40);
 elsif p_stage='TP2' then
   if not v_trade.tp1_done or v_trade.tp2_done or v_trade.tp2_price is null or
     not ((v_trade.side='BUY' and p_exit_price>=v_trade.tp2_price) or (v_trade.side='SELL' and p_exit_price<=v_trade.tp2_price))
     then return jsonb_build_object('ok',false,'reason','TP2_NOT_REACHED'); end if;
   v_qty:=least(v_trade.remaining_quantity,v_trade.quantity*0.30);
 elsif p_stage='TP3' then
   if not v_trade.tp2_done or v_trade.tp3_done or v_trade.tp3_price is null or
     not ((v_trade.side='BUY' and p_exit_price>=v_trade.tp3_price) or (v_trade.side='SELL' and p_exit_price<=v_trade.tp3_price))
     then return jsonb_build_object('ok',false,'reason','TP3_NOT_REACHED'); end if;
   v_qty:=v_trade.remaining_quantity;
 else
   if not ((v_trade.side='BUY' and p_exit_price<=v_trade.stop_loss) or (v_trade.side='SELL' and p_exit_price>=v_trade.stop_loss))
     then return jsonb_build_object('ok',false,'reason','STOP_NOT_REACHED'); end if;
   v_qty:=v_trade.remaining_quantity;
 end if;
 v_pnl:=round((case when v_trade.side='BUY' then p_exit_price-v_trade.entry_price else v_trade.entry_price-p_exit_price end)*v_qty*p_quote_to_usd,2);
 v_remaining:=greatest(0,v_trade.remaining_quantity-v_qty);
 v_closed:=v_remaining<=0.000000000001;
 if v_closed then v_remaining:=0; end if;
 update public.demo_paper_trades set remaining_quantity=v_remaining,
  tp1_done=tp1_done or p_stage='TP1',tp2_done=tp2_done or p_stage='TP2',tp3_done=tp3_done or p_stage='TP3',
  realized_pnl_usd=realized_pnl_usd+v_pnl,last_mark_price=p_exit_price,last_mark_at=p_quote_as_of,
  status=case when v_closed then 'CLOSED' else 'OPEN' end,closed_at=case when v_closed then now() else null end
  where id=v_trade.id;
 update public.demo_paper_sessions set current_balance=greatest(0,current_balance+v_pnl),
  status=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades
    where user_id=p_user_id and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'))
    >= starting_balance*max_daily_loss_pct/100 then 'RISK_LOCKED' else status end,
  risk_locked_at=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades where user_id=p_user_id and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi')) >= starting_balance*max_daily_loss_pct/100 then coalesce(risk_locked_at,now()) else risk_locked_at end,updated_at=now()
  where id=v_trade.session_id returning current_balance into v_balance;
 return jsonb_build_object('ok',true,'stage',p_stage,'trade_id',v_trade.id,'closed',v_closed,
  'closed_units',v_qty,'remaining_units',v_remaining,'realized_pnl_this_stage',v_pnl,
  'realized_pnl_total',v_trade.realized_pnl_usd+v_pnl,'balance',v_balance);
end $$;

revoke all on function public.claim_demo_paper_worker(uuid,integer),public.release_demo_paper_worker(uuid),
 public.open_demo_paper_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz,text,timestamptz,numeric,numeric,numeric),
 public.close_demo_paper_trade(uuid,uuid,numeric,numeric,text,timestamptz,text),
 public.mark_demo_paper_trade(uuid,uuid,numeric,timestamptz),
 public.manage_demo_paper_exit(uuid,uuid,text,numeric,numeric,text,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_demo_paper_worker(uuid,integer),public.release_demo_paper_worker(uuid),
 public.open_demo_paper_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz,text,timestamptz,numeric,numeric,numeric),
 public.close_demo_paper_trade(uuid,uuid,numeric,numeric,text,timestamptz,text),
 public.mark_demo_paper_trade(uuid,uuid,numeric,timestamptz),
 public.manage_demo_paper_exit(uuid,uuid,text,numeric,numeric,text,timestamptz) to service_role;

-- 4. Combined portfolio protection persistence and manual-trade permissions.
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

  if p_expected_state_version = 0 then
    insert into public.portfolio_profit_protection_state (
      user_id, account_mode, broker, broker_account_ref,
      peak_unrealized_profit_usd, current_unrealized_profit_usd,
      protected_profit_floor_usd, protection_active, trailing_active,
      included_position_ids, position_peak_state, membership_version, state_version,
      last_valuation_at, quote_source, quote_as_of, updated_at
    ) values (
      p_user_id, p_account_mode, p_broker, p_broker_account_ref,
      p_peak_profit_usd, p_current_profit_usd,
      p_protected_floor_usd, p_trailing_active, p_trailing_active,
      p_included_position_ids, p_position_peak_state, p_membership_version, p_state_version,
      p_last_valuation_at, p_quote_source, p_quote_as_of, now()
    )
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
    where public.portfolio_profit_protection_state.state_version = 0
    returning true into v_saved;
  else
    update public.portfolio_profit_protection_state set
      peak_unrealized_profit_usd = p_peak_profit_usd,
      current_unrealized_profit_usd = p_current_profit_usd,
      protected_profit_floor_usd = p_protected_floor_usd,
      protection_active = p_trailing_active,
      trailing_active = p_trailing_active,
      included_position_ids = p_included_position_ids,
      position_peak_state = p_position_peak_state,
      membership_version = p_membership_version,
      state_version = p_state_version,
      last_valuation_at = p_last_valuation_at,
      quote_source = p_quote_source,
      quote_as_of = p_quote_as_of,
      updated_at = now()
    where user_id = p_user_id and account_mode = p_account_mode
      and broker = p_broker and broker_account_ref = p_broker_account_ref
      and state_version = p_expected_state_version
    returning true into v_saved;
  end if;

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
  'Per-position USD P&L contributions per unit at the same combined portfolio-peak snapshot, with remaining units; updated atomically by the server-only portfolio monitor.';
comment on column public.portfolio_trade_permissions.close_manual_trades is
  'Separate explicit permission to close manual positions. Monitoring or inclusion permission alone never authorizes a close.';
comment on function public.save_portfolio_profit_protection_state_v2(
  uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap for account-scoped portfolio protection state.';

-- 5. Multi-position and aggregate open-risk limits; replaces the v2 single-position RPC/indexes.
-- Multi-position DEMO ledger v3.
-- Only the isolated v2 paper tables are changed. Existing production demo_bot_*,
-- bot_settings receives only the additive timeframe column and scoped column grants above; broker connections and account records are untouched.

alter table public.demo_paper_sessions
  add column if not exists max_open_positions integer not null default 3
    check (max_open_positions between 1 and 10),
  add column if not exists max_total_open_risk_pct numeric(5,2) not null default 2.00
    check (max_total_open_risk_pct > 0 and max_total_open_risk_pct <= 5);

-- Allow several simultaneous positions in the same virtual DEMO account.
-- Keep at most one BOT-managed position in a session for the current one-symbol
-- strategy runner; MANUAL positions can coexist with that BOT position.
drop index if exists public.demo_paper_one_open_trade_per_session;
drop index if exists public.demo_paper_one_open_trade_per_user;

create unique index if not exists demo_paper_one_open_bot_trade_per_session
  on public.demo_paper_trades(session_id)
  where status='OPEN' and trade_origin='BOT';

create index if not exists demo_paper_open_positions_by_user
  on public.demo_paper_trades(user_id,session_id,opened_at desc)
  where status='OPEN';

create or replace function public.open_demo_paper_trade(
 p_user_id uuid,p_session_id uuid,p_instrument text,p_side text,p_entry numeric,p_stop numeric,p_target numeric,
 p_quantity numeric,p_risk_amount numeric,p_risk_pct numeric,p_quote_to_usd numeric,
 p_quote_source text,p_quote_as_of timestamptz,p_trade_origin text default 'MANUAL',
 p_candle_as_of timestamptz default null,p_tp1 numeric default null,p_tp2 numeric default null,p_tp3 numeric default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_session public.demo_paper_sessions%rowtype;
 v_id uuid;
 v_daily_loss numeric;
 v_open_count integer;
 v_open_risk numeric;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if p_user_id is null or p_session_id is null or p_instrument is null
   or p_side is null or p_side not in('BUY','SELL')
   or p_entry is null or p_entry<=0 or p_stop is null or p_stop<=0
   or p_target is null or p_target<=0 or p_quantity is null or p_quantity<=0
   or p_risk_amount is null or p_risk_amount<=0
   or p_risk_pct is null or p_risk_pct<=0 or p_risk_pct>2
   or p_quote_to_usd is null or p_quote_to_usd<=0
   or p_quote_source is distinct from 'DERIV'
   or p_quote_as_of is null or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
   or p_trade_origin is null or p_trade_origin not in('BOT','MANUAL') then
   raise exception 'Invalid or stale paper trade';
 end if;

 select * into v_session from public.demo_paper_sessions
  where id=p_session_id and user_id=p_user_id for update;
 if not found or v_session.status<>'RUNNING' then
   return jsonb_build_object('ok',false,'reason','SESSION_NOT_RUNNING');
 end if;
 if upper(v_session.instrument)<>upper(p_instrument) then
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH');
 end if;
 if not ((p_side='BUY' and p_stop<p_entry and p_target>p_entry)
      or (p_side='SELL' and p_stop>p_entry and p_target<p_entry)) then
   raise exception 'Invalid stop/target placement';
 end if;
 if exists(select 1 from public.demo_paper_emergency_controls e
   where e.user_id=p_user_id and e.broker='DERIV'
     and e.broker_account_ref=v_session.broker_account_ref and e.entries_blocked) then
   return jsonb_build_object('ok',false,'reason','KILL_SWITCH_ACTIVE');
 end if;

 if p_risk_pct>v_session.risk_per_trade_pct
   or p_risk_amount>v_session.current_balance*v_session.risk_per_trade_pct/100
   or abs(p_risk_amount-abs(p_entry-p_stop)*p_quantity*p_quote_to_usd)>0.02 then
   raise exception 'Paper position risk does not match the server-approved session limits';
 end if;

 select count(*),
   coalesce(sum(risk_amount_usd*remaining_quantity/nullif(quantity,0)),0)
 into v_open_count,v_open_risk
 from public.demo_paper_trades
 where user_id=p_user_id and session_id=p_session_id and status='OPEN';

 if v_open_count>=v_session.max_open_positions then
   return jsonb_build_object('ok',false,'reason','MAX_OPEN_POSITIONS',
     'max_open_positions',v_session.max_open_positions);
 end if;
 if p_trade_origin='BOT' and exists(
   select 1 from public.demo_paper_trades
   where user_id=p_user_id and session_id=p_session_id
     and status='OPEN' and trade_origin='BOT'
 ) then
   return jsonb_build_object('ok',false,'reason','BOT_POSITION_EXISTS');
 end if;
 if v_open_risk+p_risk_amount > v_session.current_balance*v_session.max_total_open_risk_pct/100+0.000001 then
   return jsonb_build_object('ok',false,'reason','TOTAL_OPEN_RISK_LIMIT',
     'open_risk_usd',round(v_open_risk,2),
     'max_open_risk_usd',round(v_session.current_balance*v_session.max_total_open_risk_pct/100,2));
 end if;

 v_daily_loss := greatest(0,-coalesce((
   select sum(realized_pnl_usd) from public.demo_paper_trades
   where user_id=p_user_id
     and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'
 ),0));
 if v_daily_loss >= v_session.starting_balance*v_session.max_daily_loss_pct/100 then
   update public.demo_paper_sessions
    set status='RISK_LOCKED',risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now()
    where id=p_session_id;
   return jsonb_build_object('ok',false,'reason','DAILY_LOSS_LIMIT');
 end if;

 insert into public.demo_paper_trades(
   session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
   tp1_price,tp2_price,tp3_price,quantity,remaining_quantity,risk_amount_usd,
   risk_pct,quote_to_usd,quote_source,quote_as_of,candle_as_of,trade_origin
 ) values(
   p_session_id,p_user_id,p_instrument,p_side,p_entry,p_stop,p_target,
   p_tp1,p_tp2,p_tp3,p_quantity,p_quantity,p_risk_amount,
   p_risk_pct,p_quote_to_usd,p_quote_source,p_quote_as_of,p_candle_as_of,p_trade_origin
 ) returning id into v_id;

 update public.demo_paper_sessions
  set last_candle_as_of=coalesce(p_candle_as_of,last_candle_as_of),updated_at=now()
  where id=p_session_id;

 return jsonb_build_object(
   'ok',true,'trade_id',v_id,'status','OPEN','instrument',p_instrument,'side',p_side,
   'entry_price',p_entry,'stop_loss',p_stop,'take_profit',p_target,'quantity',p_quantity,
   'risk_amount_usd',p_risk_amount,'risk_pct',p_risk_pct,'opened_at',now(),
   'open_positions',v_open_count+1,'max_open_positions',v_session.max_open_positions,
   'remaining_open_risk_usd',round(v_open_risk+p_risk_amount,2)
 );
end;
$$;

comment on column public.demo_paper_sessions.max_open_positions is
 'Maximum simultaneous virtual positions in this DEMO session, including MANUAL and BOT positions.';
comment on column public.demo_paper_sessions.max_total_open_risk_pct is
 'Aggregate initial stop risk cap as a percentage of the virtual account balance; prevents stacking individually valid trades beyond the account risk budget.';

-- 6. Atomic permission-gated portfolio close.
-- Atomic permission-gated, idempotent portfolio closes for the isolated DEMO ledger.
-- User-initiated manual closes continue through close_demo_paper_trade with MANUAL_CLOSE.
-- Portfolio-triggered closes must use this RPC so permission revocation and close
-- serialize on the same permission row.

create or replace function public.close_demo_portfolio_trade(
  p_user_id uuid,
  p_trade_id uuid,
  p_instrument text,
  p_exit_price numeric,
  p_quote_to_usd numeric,
  p_quote_source text,
  p_quote_as_of timestamptz,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trade public.demo_paper_trades%rowtype;
  v_session public.demo_paper_sessions%rowtype;
  v_permission public.portfolio_trade_permissions%rowtype;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_user_id is null or p_trade_id is null
     or p_instrument is null or nullif(trim(p_instrument),'') is null
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_to_usd is null or p_quote_to_usd <= 0
     or p_quote_source is distinct from 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds'
     or p_idempotency_key is null or nullif(trim(p_idempotency_key),'') is null
     or length(p_idempotency_key) > 200 then
    raise exception 'Invalid or stale portfolio close request';
  end if;

  select * into v_trade
    from public.demo_paper_trades
   where id = p_trade_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_FOUND');
  end if;
  if upper(v_trade.instrument) <> upper(p_instrument) then
    return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH');
  end if;

  if v_trade.status = 'CLOSED' then
    if v_trade.metadata->>'portfolio_close_request_key' = p_idempotency_key then
      return jsonb_build_object('ok',true,'already_closed',true,'trade_id',v_trade.id,
        'reason','PORTFOLIO_PROFIT_GIVEBACK','idempotency_key',p_idempotency_key);
    end if;
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN');
  end if;

  select * into v_session
    from public.demo_paper_sessions
   where id = v_trade.session_id and user_id = p_user_id
   for share;
  if not found or v_session.broker <> 'DERIV' then
    return jsonb_build_object('ok',false,'reason','DEMO_ACCOUNT_NOT_FOUND');
  end if;

  -- Lock the permission row so a concurrent revocation either commits before
  -- this check (and blocks the close) or waits until the already-authorized
  -- close transaction finishes.
  select * into v_permission
    from public.portfolio_trade_permissions
   where user_id = p_user_id and account_mode = 'DEMO'
     and broker = 'DERIV' and broker_account_ref = v_session.broker_account_ref
   for update;

  if v_trade.trade_origin = 'MANUAL' then
    if not found
       or v_permission.manual_trade_management is not true
       or v_permission.close_manual_trades is not true
       or v_permission.close_managed_positions is not true then
      return jsonb_build_object('ok',false,'reason','MANUAL_CLOSE_PERMISSION_NOT_GRANTED');
    end if;
  elsif v_trade.trade_origin = 'BOT' then
    -- No permission row means the documented DEMO BOT protection defaults
    -- (monitor and close) are enabled. An explicit false flag disables it.
    if found and (v_permission.bot_trade_management is not true
       or v_permission.close_managed_positions is not true) then
      return jsonb_build_object('ok',false,'reason','BOT_CLOSE_PERMISSION_NOT_GRANTED');
    end if;
  else
    return jsonb_build_object('ok',false,'reason','UNSUPPORTED_TRADE_ORIGIN');
  end if;

  update public.demo_paper_trades
     set metadata = coalesce(metadata,'{}'::jsonb) ||
       jsonb_build_object('portfolio_close_request_key',p_idempotency_key,
                          'portfolio_close_reason','PORTFOLIO_PROFIT_GIVEBACK')
   where id = v_trade.id;

  v_result := public.close_demo_paper_trade(
    p_user_id,p_trade_id,p_exit_price,p_quote_to_usd,
    p_quote_source,p_quote_as_of,'MANUAL_CLOSE'
  );
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    return v_result;
  end if;
  return v_result || jsonb_build_object(
    'reason','PORTFOLIO_PROFIT_GIVEBACK',
    'idempotency_key',p_idempotency_key
  );
end;
$$;

revoke all on function public.close_demo_portfolio_trade(uuid,uuid,text,numeric,numeric,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.close_demo_portfolio_trade(uuid,uuid,text,numeric,numeric,text,timestamptz,text)
  to service_role;

comment on function public.close_demo_portfolio_trade(uuid,uuid,text,numeric,numeric,text,timestamptz,text)
  is 'Permission-locked, idempotent DEMO portfolio close. Manual positions require both monitoring and explicit close permission; no broker order is sent.';

-- 7. Server-managed instrument approval registry and audit trail. No instrument is auto-approved.
-- Server-managed allowlist for instruments that may be used by Young Tiger FX.
-- Deriv active-symbol discovery is informational only and never writes to this registry.
create table if not exists public.trading_instrument_approvals (
  id uuid primary key default gen_random_uuid(),
  broker text not null check (broker in ('DERIV','MT5')),
  instrument text not null check (instrument ~ '^[A-Za-z0-9_]{2,30}$'),
  provider text not null check (provider in ('DERIV','MT5')),
  provider_symbol text not null check (provider_symbol ~ '^[A-Za-z0-9_]{2,40}$'),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','DISABLED')),
  is_active boolean not null default false,
  approval_note text,
  approved_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (broker,instrument),
  unique (broker,provider_symbol),
  check (
    (status='APPROVED' and is_active=true and approved_at is not null)
    or status<>'APPROVED'
  ),
  check (status<>'APPROVED' or approved_by is not null)
);
comment on table public.trading_instrument_approvals is
  'Server-managed trading allowlist. Provider discovery never inserts or approves rows. Empty registry means all instruments are denied.';
comment on column public.trading_instrument_approvals.provider_symbol is
  'Exact server-side provider contract symbol. Must match the live feed adapter response; never inferred from browser input.';
comment on column public.trading_instrument_approvals.status is
  'PENDING and DISABLED are denied. Only APPROVED plus is_active=true is eligible for subsequent server-side checks.';

create table if not exists public.trading_instrument_approval_audit (
  id bigint generated always as identity primary key,
  approval_id uuid,
  broker text not null,
  instrument text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  old_record jsonb,
  new_record jsonb,
  actor_user_id uuid,
  actor_role text,
  occurred_at timestamptz not null default now()
);
comment on table public.trading_instrument_approval_audit is
  'Append-only audit trail for server-managed instrument approval changes.';

create or replace function public.audit_trading_instrument_approval()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_id uuid;
  v_broker text;
  v_instrument text;
  v_actor uuid;
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op='INSERT' then
    v_id:=new.id; v_broker:=new.broker; v_instrument:=new.instrument;
    v_actor:=coalesce(auth.uid(),new.updated_by,new.approved_by);
    v_new:=to_jsonb(new);
  elsif tg_op='UPDATE' then
    v_id:=new.id; v_broker:=new.broker; v_instrument:=new.instrument;
    v_actor:=coalesce(auth.uid(),new.updated_by,old.updated_by,new.approved_by,old.approved_by);
    v_old:=to_jsonb(old); v_new:=to_jsonb(new);
  else
    v_id:=old.id; v_broker:=old.broker; v_instrument:=old.instrument;
    v_actor:=coalesce(auth.uid(),old.updated_by,old.approved_by);
    v_old:=to_jsonb(old);
  end if;

  insert into public.trading_instrument_approval_audit
    (approval_id,broker,instrument,operation,old_record,new_record,actor_user_id,actor_role)
  values (v_id,v_broker,v_instrument,tg_op,v_old,v_new,v_actor,coalesce(auth.role(),'unknown'));

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trading_instrument_approval_audit_trigger
  on public.trading_instrument_approvals;
create trigger trading_instrument_approval_audit_trigger
  after insert or update or delete on public.trading_instrument_approvals
  for each row execute function public.audit_trading_instrument_approval();

alter table public.trading_instrument_approvals enable row level security;
alter table public.trading_instrument_approval_audit enable row level security;
revoke all on public.trading_instrument_approvals,public.trading_instrument_approval_audit
  from public,anon,authenticated;
grant select,insert,update,delete on public.trading_instrument_approvals to service_role;
grant select,insert on public.trading_instrument_approval_audit to service_role;
grant usage,select on sequence public.trading_instrument_approval_audit_id_seq to service_role;

-- 8. Append-only realized-P&L events and daily-loss lock.
-- Record each realized P&L change in the isolated v2/v3 DEMO paper ledger.
-- This prevents a partial exit on one day from being incorrectly carried into
-- a later day's cumulative trade P&L when the remaining quantity is closed.
-- Additive only: no production broker tables or REAL accounts are changed.

create table if not exists public.demo_paper_realized_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  trade_id uuid not null references public.demo_paper_trades(id) on delete cascade,
  realized_pnl_delta_usd numeric(18,2) not null,
  realized_at timestamptz not null default now(),
  event_source text not null default 'TRADE_REALIZED_PNL_UPDATE'
    check (event_source = 'TRADE_REALIZED_PNL_UPDATE')
);

create index if not exists demo_paper_realized_events_user_day_idx
  on public.demo_paper_realized_events(user_id, realized_at desc);

alter table public.demo_paper_realized_events enable row level security;
revoke all on public.demo_paper_realized_events from public, anon, authenticated;
grant all on public.demo_paper_realized_events to service_role;

create or replace function public.record_demo_paper_realized_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delta numeric(18,2);
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
begin
  if new.realized_pnl_usd is not distinct from old.realized_pnl_usd then
    return new;
  end if;

  v_delta := round(coalesce(new.realized_pnl_usd,0) - coalesce(old.realized_pnl_usd,0),2);
  if v_delta = 0 then
    return new;
  end if;

  insert into public.demo_paper_realized_events(
    user_id,session_id,trade_id,realized_pnl_delta_usd
  ) values (new.user_id,new.session_id,new.id,v_delta);

  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  -- Lock every active virtual session for this user once the daily loss
  -- threshold is reached. This happens in the same transaction as the P&L
  -- update, so another entry cannot slip through between realization and lock.
  update public.demo_paper_sessions
     set status = 'RISK_LOCKED',
         risk_locked_at = coalesce(risk_locked_at,now()),
         updated_at = now()
   where user_id = new.user_id
     and status in ('RUNNING','PAUSED')
     and v_daily_loss >= starting_balance * max_daily_loss_pct / 100;

  return new;
end;
$$;

drop trigger if exists demo_paper_record_realized_event
  on public.demo_paper_trades;
create trigger demo_paper_record_realized_event
after update of realized_pnl_usd on public.demo_paper_trades
for each row
execute function public.record_demo_paper_realized_event();

create or replace function public.guard_new_demo_paper_session_daily_loss()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
begin
  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  if v_daily_loss >= new.starting_balance * new.max_daily_loss_pct / 100 then
    new.status := 'RISK_LOCKED';
    new.risk_locked_at := coalesce(new.risk_locked_at,now());
  end if;
  return new;
end;
$$;

drop trigger if exists demo_paper_guard_new_session_daily_loss
  on public.demo_paper_sessions;
create trigger demo_paper_guard_new_session_daily_loss
before insert on public.demo_paper_sessions
for each row
execute function public.guard_new_demo_paper_session_daily_loss();

revoke all on function public.record_demo_paper_realized_event()
  from public, anon, authenticated;
revoke all on function public.guard_new_demo_paper_session_daily_loss()
  from public, anon, authenticated;

comment on table public.demo_paper_realized_events is
'Append-only audit of each change to cumulative realized P&L in the isolated DEMO paper ledger. Negative realization deltas count toward the Nairobi trading-day loss lock.';

-- Final assertions: required core objects now exist.
do $$ begin
  if to_regclass('public.demo_paper_sessions') is null or to_regclass('public.demo_paper_trades') is null then raise exception 'DEMO ledger installation incomplete'; end if;
  if to_regclass('public.trading_instrument_approvals') is null or to_regclass('public.portfolio_trade_permissions') is null then raise exception 'DEMO permissions or instrument registry installation incomplete'; end if;
  if to_regprocedure('public.open_demo_paper_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamp with time zone,text,timestamp with time zone,numeric,numeric,numeric)') is null then raise exception 'DEMO open RPC missing'; end if;
end $$;

commit;
