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
