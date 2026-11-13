-- Automatic staged TP1/TP2/TP3 exits for DEMO paper positions.
-- REAL execution is deliberately not enabled by this migration.
alter table public.demo_bot_trades
  add column if not exists initial_virtual_units numeric(24,8),
  add column if not exists tp1_price numeric(20,8),
  add column if not exists tp2_price numeric(20,8),
  add column if not exists tp3_price numeric(20,8),
  add column if not exists tp1_done boolean not null default false,
  add column if not exists tp2_done boolean not null default false,
  add column if not exists tp3_done boolean not null default false;

update public.demo_bot_trades
   set initial_virtual_units = coalesce(initial_virtual_units, virtual_units),
       tp1_price = coalesce(tp1_price, case when direction='BUY' then entry_price + abs(entry_price-stop_loss) else entry_price - abs(entry_price-stop_loss) end),
       tp2_price = coalesce(tp2_price, case when direction='BUY' then entry_price + 2*abs(entry_price-stop_loss) else entry_price - 2*abs(entry_price-stop_loss) end),
       tp3_price = coalesce(tp3_price, take_profit)
 where initial_virtual_units is null or tp1_price is null or tp2_price is null or tp3_price is null;

create or replace function public.set_demo_trade_take_profit_plan()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.initial_virtual_units := coalesce(new.initial_virtual_units, new.virtual_units);
  new.tp1_price := coalesce(new.tp1_price,
    case when new.direction='BUY' then new.entry_price + abs(new.entry_price-new.stop_loss)
         else new.entry_price - abs(new.entry_price-new.stop_loss) end);
  new.tp2_price := coalesce(new.tp2_price,
    case when new.direction='BUY' then new.entry_price + 2*abs(new.entry_price-new.stop_loss)
         else new.entry_price - 2*abs(new.entry_price-new.stop_loss) end);
  new.tp3_price := coalesce(new.tp3_price, new.take_profit);
  return new;
end;
$$;

drop trigger if exists demo_trade_take_profit_plan on public.demo_bot_trades;
create trigger demo_trade_take_profit_plan
before insert on public.demo_bot_trades
for each row execute function public.set_demo_trade_take_profit_plan();

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
  select coalesce(sum(least(realized_pnl,0)),0) into v_daily_loss
   from public.demo_bot_trades where user_id=p_user_id and status='CLOSED' and closed_at>=v_day_start;
  v_daily_limit := v_session.starting_balance*v_session.max_daily_loss_pct/100;
  if abs(v_daily_loss)>=v_daily_limit then
    update public.demo_bot_sessions set status='RISK_LOCKED',stopped_at=now(),updated_at=now()
     where id=v_session.id and status='RUNNING';
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

revoke all on function public.manage_demo_auto_trade_exit(uuid,uuid,text,numeric,text,timestamptz) from public,anon,authenticated;
grant execute on function public.manage_demo_auto_trade_exit(uuid,uuid,text,numeric,text,timestamptz) to service_role;

comment on function public.manage_demo_auto_trade_exit(uuid,uuid,text,numeric,text,timestamptz) is
'Atomically manages DEMO BOT partial exits: 40% at TP1 (1R), 30% at TP2 (2R), remainder at TP3 (3R), or remaining size at stop. Updates cumulative realized P&L and virtual balance.';
