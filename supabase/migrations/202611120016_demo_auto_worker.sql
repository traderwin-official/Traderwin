
-- Allow authenticated owners to save the worker's selected timeframe and validated strategy.
grant insert(user_id,broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;
grant update(broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;

-- The worker supports only validated candle intervals and explicitly marks bot-originated trades.
alter table public.bot_settings
  add column if not exists timeframe text not null default 'M15';
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bot_settings'::regclass
       and conname = 'bot_settings_timeframe_check'
  ) then
    alter table public.bot_settings
      add constraint bot_settings_timeframe_check
      check (timeframe in ('M5','M15','H1','H4'));
  end if;
end $$;

alter table public.demo_bot_trades
  add column if not exists trade_source text not null default 'MANUAL';
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.demo_bot_trades'::regclass
       and conname = 'demo_bot_trades_trade_source_check'
  ) then
    alter table public.demo_bot_trades
      add constraint demo_bot_trades_trade_source_check
      check (trade_source in ('BOT','MANUAL'));
  end if;
end $$;

create table if not exists public.demo_bot_worker_heartbeats (
  session_id uuid primary key references public.demo_bot_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_tick_at timestamptz not null,
  last_action text not null,
  last_reason text,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.demo_bot_worker_heartbeats enable row level security;
drop policy if exists "Users read own demo worker heartbeat" on public.demo_bot_worker_heartbeats;
create policy "Users read own demo worker heartbeat" on public.demo_bot_worker_heartbeats
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.demo_bot_worker_heartbeats from public, anon, authenticated;
grant select on public.demo_bot_worker_heartbeats to authenticated;
revoke all on public.demo_bot_worker_heartbeats from service_role;
grant all on public.demo_bot_worker_heartbeats to service_role;

-- Server-side DEMO worker coordination and atomic paper-trade lifecycle.
alter table public.demo_bot_sessions
  add column if not exists worker_last_candle_as_of timestamptz;

create table if not exists public.traderwin_worker_leases (
  worker_key text primary key,
  lease_token uuid not null,
  lease_until timestamptz not null,
  updated_at timestamptz not null default now()
);
revoke all on public.traderwin_worker_leases from public, anon, authenticated;

create or replace function public.claim_traderwin_demo_worker(
  p_lease_token uuid,
  p_lease_seconds integer default 50
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_claimed boolean := false;
begin
  if p_lease_token is null or p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 120 then
    raise exception 'Invalid worker lease request';
  end if;
  insert into public.traderwin_worker_leases(worker_key, lease_token, lease_until)
  values ('DEMO_AUTO_WORKER', p_lease_token, now() + make_interval(secs => p_lease_seconds))
  on conflict(worker_key) do update
    set lease_token = excluded.lease_token,
        lease_until = excluded.lease_until,
        updated_at = now()
    where public.traderwin_worker_leases.lease_until < now()
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_traderwin_demo_worker(p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_released boolean := false;
begin
  update public.traderwin_worker_leases
     set lease_until = now(), updated_at = now()
   where worker_key = 'DEMO_AUTO_WORKER' and lease_token = p_lease_token
  returning true into v_released;
  return coalesce(v_released, false);
end;
$$;

create or replace function public.open_demo_auto_trade(
  p_user_id uuid,
  p_session_id uuid,
  p_symbol text,
  p_direction text,
  p_entry_price numeric,
  p_stop_loss numeric,
  p_take_profit numeric,
  p_virtual_units numeric,
  p_risk_amount numeric,
  p_risk_pct numeric,
  p_quote_source text,
  p_quote_as_of timestamptz,
  p_candle_as_of timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_bot_sessions%rowtype;
  v_instrument text;
  v_trade_id uuid;
begin
  if p_user_id is null or p_session_id is null
     or nullif(trim(p_symbol), '') is null
     or p_direction is null or p_direction not in ('BUY','SELL')
     or p_entry_price is null or p_entry_price <= 0
     or p_stop_loss is null or p_stop_loss <= 0
     or p_take_profit is null or p_take_profit <= 0
     or p_virtual_units is null or p_virtual_units <= 0
     or p_risk_amount is null or p_risk_amount <= 0
     or p_risk_pct is null or p_risk_pct <= 0 or p_risk_pct > 2
     or p_quote_source is null or p_quote_source <> 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now() or p_quote_as_of < now() - interval '30 seconds'
     or p_candle_as_of is null or p_candle_as_of > now() then
    raise exception 'Invalid or stale DEMO auto-trade request';
  end if;
  if not ((p_direction = 'BUY' and p_stop_loss < p_entry_price and p_take_profit > p_entry_price)
       or (p_direction = 'SELL' and p_stop_loss > p_entry_price and p_take_profit < p_entry_price)) then
    raise exception 'Invalid stop-loss or take-profit placement';
  end if;

  select * into v_session
    from public.demo_bot_sessions
   where id = p_session_id and user_id = p_user_id and account_mode = 'DEMO'
   for update;
  if not found or v_session.status <> 'RUNNING' then return null; end if;
  if p_risk_pct > v_session.max_risk_per_trade_pct
     or p_risk_amount > v_session.current_balance * v_session.max_risk_per_trade_pct / 100 then
    raise exception 'DEMO risk limit exceeded';
  end if;
  select instrument into v_instrument
    from public.bot_settings
   where id = v_session.bot_setting_id and user_id = p_user_id and account_mode = 'DEMO';
  if v_instrument is null or upper(v_instrument) <> upper(p_symbol) then
    raise exception 'Instrument does not match saved DEMO bot settings';
  end if;
  if v_session.worker_last_candle_as_of is not null
     and v_session.worker_last_candle_as_of >= p_candle_as_of then
    return null;
  end if;
  if exists (select 1 from public.demo_bot_trades where session_id = p_session_id and status = 'OPEN') then
    return null;
  end if;

  insert into public.demo_bot_trades(
    session_id,user_id,symbol,direction,entry_price,stop_loss,take_profit,
    virtual_units,risk_amount,risk_pct,quote_source,quote_as_of,trade_source
  ) values (
    p_session_id,p_user_id,p_symbol,p_direction,p_entry_price,p_stop_loss,p_take_profit,
    p_virtual_units,p_risk_amount,p_risk_pct,p_quote_source,p_quote_as_of,'BOT'
  ) returning id into v_trade_id;

  update public.demo_bot_sessions
     set worker_last_candle_as_of = p_candle_as_of, updated_at = now()
   where id = p_session_id;
  return v_trade_id;
end;
$$;

create or replace function public.close_demo_auto_trade(
  p_user_id uuid,
  p_trade_id uuid,
  p_exit_price numeric,
  p_quote_source text,
  p_quote_as_of timestamptz,
  p_close_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trade public.demo_bot_trades%rowtype;
  v_session public.demo_bot_sessions%rowtype;
  v_pnl numeric(14,2);
  v_next_balance numeric(14,2);
  v_day_start timestamptz;
  v_daily_loss numeric(14,2);
  v_daily_limit numeric(14,2);
  v_locked boolean := false;
begin
  if p_user_id is null or p_trade_id is null
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_source <> 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now() or p_quote_as_of < now() - interval '30 seconds'
     or p_close_reason is null or p_close_reason not in ('STOP_LOSS','TAKE_PROFIT','MANUAL_STOP') then
    raise exception 'Invalid or stale DEMO close request';
  end if;

  select * into v_trade
    from public.demo_bot_trades
   where id = p_trade_id and user_id = p_user_id and status = 'OPEN'
   for update;
  if not found then return jsonb_build_object('closed', false, 'reason', 'TRADE_NOT_OPEN'); end if;
  if v_trade.trade_source <> 'BOT' then
    return jsonb_build_object('closed', false, 'reason', 'MANUAL_TRADE_NOT_MANAGED');
  end if;

  select * into v_session
    from public.demo_bot_sessions
   where id = v_trade.session_id and user_id = p_user_id
   for update;
  if not found or v_session.account_mode <> 'DEMO' then
    raise exception 'DEMO session not found';
  end if;

  if p_close_reason = 'STOP_LOSS' and not (
       (v_trade.direction = 'BUY' and p_exit_price <= v_trade.stop_loss) or
       (v_trade.direction = 'SELL' and p_exit_price >= v_trade.stop_loss)) then
    raise exception 'Stop-loss price was not reached';
  end if;
  if p_close_reason = 'TAKE_PROFIT' and not (
       (v_trade.direction = 'BUY' and p_exit_price >= v_trade.take_profit) or
       (v_trade.direction = 'SELL' and p_exit_price <= v_trade.take_profit)) then
    raise exception 'Take-profit price was not reached';
  end if;

  v_pnl := round(
    (case when v_trade.direction = 'BUY'
      then p_exit_price - v_trade.entry_price
      else v_trade.entry_price - p_exit_price end) * v_trade.virtual_units, 2
  );
  update public.demo_bot_trades
     set exit_price = p_exit_price, realized_pnl = v_pnl,
         status = 'CLOSED', closed_at = now(),
         last_mark_price = p_exit_price, last_mark_at = p_quote_as_of
   where id = p_trade_id and status = 'OPEN';

  v_next_balance := greatest(0, v_session.current_balance + v_pnl);
  update public.demo_bot_sessions
     set current_balance = v_next_balance, updated_at = now()
   where id = v_session.id;

  v_day_start := date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  select coalesce(sum(least(realized_pnl, 0)), 0)
    into v_daily_loss
    from public.demo_bot_trades
   where user_id = p_user_id and status = 'CLOSED' and closed_at >= v_day_start;
  v_daily_limit := v_session.starting_balance * v_session.max_daily_loss_pct / 100;
  if abs(v_daily_loss) >= v_daily_limit then
    update public.demo_bot_sessions
       set status = 'RISK_LOCKED', stopped_at = now(), updated_at = now()
     where id = v_session.id and status = 'RUNNING';
    v_locked := true;
  end if;

  insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
  values (p_user_id,v_session.bot_setting_id,
    case when v_locked then 'RISK_BLOCK' else 'DEMO_ORDER' end,
    'DEMO',
    jsonb_build_object('trade_id',p_trade_id,'action','AUTO_CLOSE',
      'reason',p_close_reason,'exit_price',p_exit_price,'realized_pnl',v_pnl,
      'daily_loss',abs(v_daily_loss),'daily_loss_limit',v_daily_limit,
      'quote_source',p_quote_source,'quote_as_of',p_quote_as_of));

  return jsonb_build_object('closed', true, 'trade_id', p_trade_id,
    'exit_price', p_exit_price, 'realized_pnl', v_pnl,
    'current_balance', v_next_balance, 'risk_locked', v_locked,
    'close_reason', p_close_reason);
end;
$$;

revoke all on function public.claim_traderwin_demo_worker(uuid,integer) from public,anon,authenticated;
revoke all on function public.release_traderwin_demo_worker(uuid) from public,anon,authenticated;
revoke all on function public.open_demo_auto_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.close_demo_auto_trade(uuid,uuid,numeric,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.claim_traderwin_demo_worker(uuid,integer) to service_role;
grant execute on function public.release_traderwin_demo_worker(uuid) to service_role;
grant execute on function public.open_demo_auto_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz,timestamptz) to service_role;
grant execute on function public.close_demo_auto_trade(uuid,uuid,numeric,text,timestamptz,text) to service_role;

comment on table public.traderwin_worker_leases is 'Service-role-only singleton lease preventing overlapping DEMO worker runs.';
comment on function public.open_demo_auto_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz,timestamptz) is 'Atomically opens one DEMO paper position only for a new completed candle and a running DEMO session.';
comment on function public.close_demo_auto_trade(uuid,uuid,numeric,text,timestamptz,text) is 'Atomically closes a DEMO paper position, updates virtual balance and applies the Nairobi-day loss lock.';
