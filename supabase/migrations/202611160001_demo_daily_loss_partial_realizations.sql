-- Count realized losses on the day they are realized, including partial TP/stop stages.
-- Legacy fully closed trades without staged activity records remain covered.
create or replace function public.demo_daily_realized_loss(
  p_user_id uuid,
  p_day_start timestamptz,
  p_exclude_trade_id uuid default null
) returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce((
      select sum(least(
        case
          when coalesce(a.details->>'realized_pnl_this_stage', a.details->>'realized_pnl')
               ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          then coalesce(a.details->>'realized_pnl_this_stage', a.details->>'realized_pnl')::numeric
          else 0
        end,
        0
      ))
      from public.bot_activity a
      where a.user_id = p_user_id
        and a.account_mode = 'DEMO'
        and a.created_at >= p_day_start
        and a.event_type in ('DEMO_ORDER','RISK_BLOCK')
        and a.details->>'action' in ('TP1','TP2','TP3','STOP_LOSS','AUTO_CLOSE','MANUAL_CLOSE')
    ), 0)
    +
    coalesce((
      select sum(least(t.realized_pnl, 0))
      from public.demo_bot_trades t
      where t.user_id = p_user_id
        and t.status = 'CLOSED'
        and t.closed_at >= p_day_start
        and (p_exclude_trade_id is null or t.id <> p_exclude_trade_id)
        and not exists (
          select 1
          from public.bot_activity a
          where a.user_id = t.user_id
            and a.details->>'trade_id' = t.id::text
            and a.details->>'action' in ('TP1','TP2','TP3','STOP_LOSS','AUTO_CLOSE','MANUAL_CLOSE')
        )
    ), 0);
$$;

revoke all on function public.demo_daily_realized_loss(uuid,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.demo_daily_realized_loss(uuid,timestamptz,uuid) to service_role;


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
  v_day_start timestamptz;
  v_daily_loss numeric(14,2);
  v_daily_limit numeric(14,2);
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
  if exists (
    select 1 from public.bot_emergency_controls
     where user_id = p_user_id and account_mode = 'DEMO'
       and broker = 'DERIV' and broker_account_ref = 'DEMO:' || p_user_id::text
       and kill_switch_active = true
  ) then
    insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
    values (p_user_id,v_session.bot_setting_id,'RISK_BLOCK','DEMO',
      jsonb_build_object('reason','KILL_SWITCH_ACTIVE','action','AUTO_ENTRY_BLOCKED'));
    return null;
  end if;
  v_day_start := date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  v_daily_loss := public.demo_daily_realized_loss(p_user_id, v_day_start, null);
  v_daily_limit := v_session.starting_balance * v_session.max_daily_loss_pct / 100;
  if abs(v_daily_loss) >= v_daily_limit then
    update public.demo_bot_sessions
       set status = 'RISK_LOCKED', stopped_at = now(), updated_at = now()
     where id = v_session.id and status in ('RUNNING','PAUSED');
    insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
    values (p_user_id,v_session.bot_setting_id,'RISK_BLOCK','DEMO',
      jsonb_build_object('reason','DAILY_LOSS_LIMIT','daily_loss',abs(v_daily_loss),'limit',v_daily_limit));
    return null;
  end if;
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
  if exists (select 1 from public.demo_bot_trades where user_id = p_user_id and status = 'OPEN') then
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
  insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
  values (p_user_id,v_session.bot_setting_id,'DEMO_ORDER','DEMO',
    jsonb_build_object('trade_id',v_trade_id,'action','AUTO_OPEN',
      'symbol',p_symbol,'direction',p_direction,'entry_price',p_entry_price,
      'stop_loss',p_stop_loss,'take_profit',p_take_profit,
      'risk_amount',p_risk_amount,'risk_pct',p_risk_pct,
      'quote_source',p_quote_source,'quote_as_of',p_quote_as_of,
      'candle_as_of',p_candle_as_of));
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
     or p_quote_source is null or p_quote_source <> 'DERIV'
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
  v_daily_loss := public.demo_daily_realized_loss(p_user_id, v_day_start, p_trade_id) + least(v_pnl, 0);
  v_daily_limit := v_session.starting_balance * v_session.max_daily_loss_pct / 100;
  if abs(v_daily_loss) >= v_daily_limit then
    update public.demo_bot_sessions
       set status = 'RISK_LOCKED', stopped_at = now(), updated_at = now()
     where id = v_session.id and status in ('RUNNING','PAUSED');
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

create or replace function public.manage_demo_auto_trade_exit(
  p_user_id uuid,
  p_trade_id uuid,
  p_stage text,
  p_exit_price numeric,
  p_quote_source text,
  p_quote_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trade public.demo_bot_trades%rowtype;
  v_session public.demo_bot_sessions%rowtype;
  v_close_units numeric(24,8);
  v_remaining numeric(24,8);
  v_pnl numeric(14,2);
  v_cumulative numeric(14,2);
  v_next_balance numeric(14,2);
  v_final boolean := false;
  v_day_start timestamptz;
  v_daily_loss numeric(14,2);
  v_daily_limit numeric(14,2);
  v_locked boolean := false;
begin
  if p_user_id is null or p_trade_id is null or p_stage is null
     or p_stage not in ('STOP_LOSS','TP1','TP2','TP3')
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_source is null or p_quote_source <> 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds' then
    raise exception 'Invalid or stale DEMO trade-exit request';
  end if;

  select * into v_trade from public.demo_bot_trades
   where id=p_trade_id and user_id=p_user_id and status='OPEN'
   for update;
  if not found then return jsonb_build_object('closed',false,'reason','TRADE_NOT_OPEN'); end if;
  if v_trade.trade_source <> 'BOT' then
    return jsonb_build_object('closed',false,'reason','MANUAL_TRADE_NOT_MANAGED');
  end if;
  select * into v_session from public.demo_bot_sessions
   where id=v_trade.session_id and user_id=p_user_id for update;
  if not found or v_session.account_mode <> 'DEMO' then raise exception 'DEMO session not found'; end if;

  if p_stage='STOP_LOSS' then
    if not ((v_trade.direction='BUY' and p_exit_price<=v_trade.stop_loss) or
            (v_trade.direction='SELL' and p_exit_price>=v_trade.stop_loss)) then
      raise exception 'Stop-loss price was not reached';
    end if;
    v_close_units := v_trade.virtual_units;
    v_final := true;
  elsif p_stage='TP1' then
    if v_trade.tp1_done or not ((v_trade.direction='BUY' and p_exit_price>=v_trade.tp1_price) or
                               (v_trade.direction='SELL' and p_exit_price<=v_trade.tp1_price)) then
      raise exception 'TP1 is already processed or its target was not reached';
    end if;
    v_close_units := floor(v_trade.initial_virtual_units*0.40*100000000)/100000000;
  elsif p_stage='TP2' then
    if not v_trade.tp1_done or v_trade.tp2_done or
       not ((v_trade.direction='BUY' and p_exit_price>=v_trade.tp2_price) or
            (v_trade.direction='SELL' and p_exit_price<=v_trade.tp2_price)) then
      raise exception 'TP2 is not ready or its target was not reached';
    end if;
    v_close_units := floor(v_trade.initial_virtual_units*0.30*100000000)/100000000;
  elsif p_stage='TP3' then
    if not v_trade.tp2_done or v_trade.tp3_done or
       not ((v_trade.direction='BUY' and p_exit_price>=v_trade.tp3_price) or
            (v_trade.direction='SELL' and p_exit_price<=v_trade.tp3_price)) then
      raise exception 'TP3 is not ready or its target was not reached';
    end if;
    v_close_units := v_trade.virtual_units;
    v_final := true;
  end if;

  if v_close_units is null or v_close_units<=0 or v_close_units>v_trade.virtual_units then
    raise exception 'Calculated partial-close volume is invalid';
  end if;
  v_remaining := greatest(0, v_trade.virtual_units-v_close_units);
  v_pnl := round((case when v_trade.direction='BUY'
    then p_exit_price-v_trade.entry_price else v_trade.entry_price-p_exit_price end)*v_close_units,2);
  v_cumulative := coalesce(v_trade.realized_pnl,0)+v_pnl;
  v_next_balance := greatest(0,v_session.current_balance+v_pnl);

  update public.demo_bot_trades set
    virtual_units=v_remaining,
    realized_pnl=v_cumulative,
    exit_price=p_exit_price,
    last_mark_price=p_exit_price,
    last_mark_at=p_quote_as_of,
    tp1_done=tp1_done or p_stage='TP1',
    tp2_done=tp2_done or p_stage='TP2',
    tp3_done=tp3_done or p_stage='TP3',
    status=case when v_final then 'CLOSED' else status end,
    closed_at=case when v_final then now() else closed_at end
  where id=p_trade_id and status='OPEN';

  update public.demo_bot_sessions set current_balance=v_next_balance,updated_at=now()
   where id=v_session.id;

  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  v_daily_loss := public.demo_daily_realized_loss(p_user_id, v_day_start, p_trade_id) + least(v_pnl, 0);
  v_daily_limit := v_session.starting_balance*v_session.max_daily_loss_pct/100;
  if abs(v_daily_loss)>=v_daily_limit then
    update public.demo_bot_sessions set status='RISK_LOCKED',stopped_at=now(),updated_at=now()
     where id=v_session.id and status in ('RUNNING','PAUSED');
    v_locked := true;
  end if;

  insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
  values(p_user_id,v_session.bot_setting_id,
    case when v_locked then 'RISK_BLOCK' else 'DEMO_ORDER' end,'DEMO',
    jsonb_build_object('trade_id',p_trade_id,'action',p_stage,
      'closed_units',v_close_units,'remaining_units',v_remaining,
      'exit_price',p_exit_price,'realized_pnl_this_stage',v_pnl,
      'realized_pnl_total',v_cumulative,'quote_source',p_quote_source,
      'quote_as_of',p_quote_as_of,'risk_locked',v_locked));

  return jsonb_build_object('ok',true,'stage',p_stage,'closed',v_final,
    'closed_units',v_close_units,'remaining_units',v_remaining,
    'realized_pnl_this_stage',v_pnl,'realized_pnl_total',v_cumulative,
    'current_balance',v_next_balance,'risk_locked',v_locked);
end;
$$;

comment on function public.demo_daily_realized_loss(uuid,timestamptz,uuid) is
'Returns the total negative DEMO realized P&L for the Nairobi trading day, counting each partial exit on its realization date and preserving legacy full-close records. Service-role only.';


-- Close a user-requested DEMO paper position atomically, including any earlier partial exits.
create or replace function public.close_demo_paper_trade(
  p_user_id uuid,
  p_trade_id uuid,
  p_instrument text,
  p_exit_price numeric,
  p_quote_source text,
  p_quote_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trade public.demo_bot_trades%rowtype;
  v_session public.demo_bot_sessions%rowtype;
  v_pnl numeric(14,2);
  v_cumulative numeric(14,2);
  v_next_balance numeric(14,2);
  v_day_start timestamptz;
  v_daily_loss numeric(14,2);
  v_daily_limit numeric(14,2);
  v_locked boolean := false;
begin
  if p_user_id is null or p_trade_id is null
     or nullif(trim(p_instrument),'') is null
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_source is distinct from 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds' then
    raise exception 'Invalid or stale DEMO paper-close request';
  end if;

  select * into v_trade
    from public.demo_bot_trades
   where id = p_trade_id and user_id = p_user_id and status = 'OPEN'
   for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN');
  end if;
  if upper(trim(v_trade.symbol)) <> upper(trim(p_instrument)) then
    raise exception 'Paper-close instrument does not match the open trade';
  end if;

  select * into v_session
    from public.demo_bot_sessions
   where id = v_trade.session_id and user_id = p_user_id
   for update;
  if not found or v_session.account_mode <> 'DEMO' then
    raise exception 'DEMO session not found';
  end if;

  v_pnl := round(
    (case when v_trade.direction = 'BUY'
      then p_exit_price - v_trade.entry_price
      else v_trade.entry_price - p_exit_price end) * v_trade.virtual_units,
    2
  );
  v_cumulative := coalesce(v_trade.realized_pnl,0) + v_pnl;
  v_next_balance := greatest(0,v_session.current_balance + v_pnl);

  update public.demo_bot_trades
     set exit_price = p_exit_price,
         realized_pnl = v_cumulative,
         status = 'CLOSED',
         closed_at = now(),
         last_mark_price = p_exit_price,
         last_mark_at = p_quote_as_of
   where id = p_trade_id and user_id = p_user_id and status = 'OPEN';

  update public.demo_bot_sessions
     set current_balance = v_next_balance, updated_at = now()
   where id = v_session.id;

  insert into public.bot_activity(user_id,bot_setting_id,event_type,account_mode,details)
  values (p_user_id,v_session.bot_setting_id,'DEMO_ORDER','DEMO',
    jsonb_build_object(
      'trade_id',p_trade_id,
      'action','MANUAL_CLOSE',
      'instrument',v_trade.symbol,
      'exit_price',p_exit_price,
      'realized_pnl_this_stage',v_pnl,
      'realized_pnl_total',v_cumulative,
      'quote_source',p_quote_source,
      'quote_as_of',p_quote_as_of
    ));

  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  v_daily_loss := public.demo_daily_realized_loss(p_user_id,v_day_start,null);
  v_daily_limit := v_session.starting_balance*v_session.max_daily_loss_pct/100;
  if abs(v_daily_loss) >= v_daily_limit then
    update public.demo_bot_sessions
       set status = 'RISK_LOCKED', stopped_at = now(), updated_at = now()
     where id = v_session.id and status in ('RUNNING','PAUSED');
    v_locked := true;
  end if;

  return jsonb_build_object(
    'ok',true,
    'trade_id',p_trade_id,
    'exit_price',p_exit_price,
    'realized_pnl_this_stage',v_pnl,
    'realized_pnl_total',v_cumulative,
    'current_balance',v_next_balance,
    'daily_loss',abs(v_daily_loss),
    'daily_loss_limit',v_daily_limit,
    'risk_locked',v_locked
  );
end;
$$;

revoke all on function public.close_demo_paper_trade(uuid,uuid,text,numeric,text,timestamptz) from public, anon, authenticated;
grant execute on function public.close_demo_paper_trade(uuid,uuid,text,numeric,text,timestamptz) to service_role;

comment on function public.close_demo_paper_trade(uuid,uuid,text,numeric,text,timestamptz) is
'Atomically closes a user-requested DEMO paper position, preserves cumulative P&L from partial exits, updates virtual balance and enforces daily loss lock.';
