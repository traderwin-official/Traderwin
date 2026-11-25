-- Forward-compatible repair for databases that already have the DEMO target allocation
-- columns but are missing the staged manual exit RPCs.
-- No historical rows are rewritten and no target allocation constraints are changed.
-- DEMO paper trading only; both RPCs require service_role and never send broker orders.

create or replace function public.open_demo_manual_partial_trade(
 p_user_id uuid,
 p_session_id uuid,
 p_instrument text,
 p_side text,
 p_entry numeric,
 p_stop numeric,
 p_tp1 numeric,
 p_tp2 numeric,
 p_tp3 numeric,
 p_tp1_percent numeric,
 p_tp2_percent numeric,
 p_tp3_percent numeric,
 p_quantity numeric,
 p_risk_amount numeric,
 p_risk_pct numeric,
 p_quote_to_usd numeric,
 p_quote_source text,
 p_quote_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_tp1 numeric;
  v_tp2 numeric;
  v_tp3 numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_tp1 is null or p_tp2 is null or p_tp3 is null
     or p_tp1 <= 0 or p_tp2 <= 0 or p_tp3 <= 0
     or p_tp1_percent is null or p_tp2_percent is null or p_tp3_percent is null
     or p_tp1_percent <= 0 or p_tp2_percent <= 0 or p_tp3_percent <= 0
     or p_tp1_percent > 100 or p_tp2_percent > 100 or p_tp3_percent > 100
     or round(p_tp1_percent,2) <> p_tp1_percent
     or round(p_tp2_percent,2) <> p_tp2_percent
     or round(p_tp3_percent,2) <> p_tp3_percent
     or round(p_tp1_percent + p_tp2_percent + p_tp3_percent, 2) <> 100 then
    raise exception 'Three positive target allocations must total exactly 100 percent';
  end if;

  if not (
    (p_side = 'BUY' and p_stop < p_entry and p_entry < p_tp1 and p_tp1 < p_tp2 and p_tp2 < p_tp3)
    or
    (p_side = 'SELL' and p_stop > p_entry and p_entry > p_tp1 and p_tp1 > p_tp2 and p_tp2 > p_tp3)
  ) then
    raise exception 'Manual target levels must be ordered beyond entry in the trade direction';
  end if;

  if not exists (
    select 1 from public.demo_paper_sessions
     where id = p_session_id and user_id = p_user_id and broker = 'DERIV'
  ) then
    return jsonb_build_object('ok',false,'reason','DERIV_DEMO_SESSION_REQUIRED');
  end if;

  v_result := public.open_demo_paper_trade(
    p_user_id, p_session_id, p_instrument, p_side, p_entry, p_stop, p_tp3,
    p_quantity, p_risk_amount, p_risk_pct, p_quote_to_usd,
    p_quote_source, p_quote_as_of, 'MANUAL', null, p_tp1, p_tp2, p_tp3
  );

  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;

  update public.demo_paper_trades
     set tp1_percent = p_tp1_percent,
         tp2_percent = p_tp2_percent,
         tp3_percent = p_tp3_percent
   where id = (v_result->>'trade_id')::uuid
     and user_id = p_user_id
     and trade_origin = 'MANUAL'
     and status = 'OPEN';

  if not found then
    raise exception 'Could not persist manual partial-exit allocations';
  end if;

  return v_result || jsonb_build_object(
    'tp1_price', p_tp1, 'tp2_price', p_tp2, 'tp3_price', p_tp3,
    'tp1_percent', p_tp1_percent, 'tp2_percent', p_tp2_percent,
    'tp3_percent', p_tp3_percent
  );
end;
$$;

create or replace function public.manage_demo_manual_partial_exit(
 p_user_id uuid,
 p_trade_id uuid,
 p_stage text,
 p_exit_price numeric,
 p_quote_to_usd numeric,
 p_quote_source text,
 p_quote_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trade public.demo_paper_trades%rowtype;
  v_session public.demo_paper_sessions%rowtype;
  v_permission public.portfolio_trade_permissions%rowtype;
  v_qty numeric(28,12);
  v_remaining numeric(28,12);
  v_pnl numeric(18,2);
  v_balance numeric(18,2);
  v_target numeric(24,10);
  v_percent numeric(5,2);
  v_closed boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_user_id is null or p_trade_id is null
     or p_stage not in ('TP1','TP2','TP3','STOP_LOSS')
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_to_usd is null or p_quote_to_usd <= 0
     or p_quote_source is distinct from 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds' then
    raise exception 'Invalid or stale manual DEMO exit';
  end if;

  select * into v_trade
    from public.demo_paper_trades
   where id = p_trade_id and user_id = p_user_id
   for update;
  if not found or v_trade.status <> 'OPEN' then
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN');
  end if;
  if v_trade.trade_origin <> 'MANUAL' then
    return jsonb_build_object('ok',false,'reason','NOT_A_MANUAL_TRADE');
  end if;
  if round(v_trade.tp1_percent + v_trade.tp2_percent + v_trade.tp3_percent,2) <> 100
     or v_trade.tp1_percent <= 0 or v_trade.tp2_percent < 0 or v_trade.tp3_percent < 0
     or (v_trade.tp3_percent > 0 and v_trade.tp2_percent <= 0)
     or v_trade.tp1_price is null
     or (v_trade.tp2_percent > 0 and v_trade.tp2_price is null)
     or (v_trade.tp3_percent > 0 and v_trade.tp3_price is null)
     or not (
       (v_trade.side='BUY' and v_trade.stop_loss < v_trade.entry_price
        and v_trade.entry_price < v_trade.tp1_price
        and (v_trade.tp2_percent = 0 or v_trade.tp1_price < v_trade.tp2_price)
        and (v_trade.tp3_percent = 0 or v_trade.tp2_price < v_trade.tp3_price))
       or
       (v_trade.side='SELL' and v_trade.stop_loss > v_trade.entry_price
        and v_trade.entry_price > v_trade.tp1_price
        and (v_trade.tp2_percent = 0 or v_trade.tp1_price > v_trade.tp2_price)
        and (v_trade.tp3_percent = 0 or v_trade.tp2_price > v_trade.tp3_price))
     ) then
    return jsonb_build_object('ok',false,'reason','MANUAL_EXIT_CONFIGURATION_INVALID');
  end if;

  select * into v_session
    from public.demo_paper_sessions
   where id = v_trade.session_id and user_id = p_user_id
   for share;
  if not found or v_session.broker <> 'DERIV' then
    return jsonb_build_object('ok',false,'reason','DEMO_SESSION_NOT_FOUND');
  end if;

  select * into v_permission
    from public.portfolio_trade_permissions
   where user_id = p_user_id
     and account_mode = 'DEMO'
     and broker = 'DERIV'
     and broker_account_ref = v_session.broker_account_ref
   for update;
  if not found or v_permission.auto_exit_manual_brackets is not true then
    return jsonb_build_object('ok',false,'reason','MANUAL_BRACKET_CLOSE_PERMISSION_NOT_GRANTED');
  end if;

  if p_stage = 'STOP_LOSS' then
    if not (
      (v_trade.side = 'BUY' and p_exit_price <= v_trade.stop_loss)
      or (v_trade.side = 'SELL' and p_exit_price >= v_trade.stop_loss)
    ) then return jsonb_build_object('ok',false,'reason','STOP_LOSS_NOT_REACHED'); end if;
    v_qty := v_trade.remaining_quantity;
  else
    if p_stage = 'TP1' then
      v_target := v_trade.tp1_price; v_percent := v_trade.tp1_percent;
      if v_trade.tp1_done then return jsonb_build_object('ok',false,'reason','TP1_ALREADY_DONE'); end if;
    elsif p_stage = 'TP2' then
      if not v_trade.tp1_done then return jsonb_build_object('ok',false,'reason','TP1_NOT_DONE'); end if;
      v_target := v_trade.tp2_price; v_percent := v_trade.tp2_percent;
      if v_trade.tp2_done then return jsonb_build_object('ok',false,'reason','TP2_ALREADY_DONE'); end if;
    else
      if not v_trade.tp2_done then return jsonb_build_object('ok',false,'reason','TP2_NOT_DONE'); end if;
      v_target := v_trade.tp3_price; v_percent := v_trade.tp3_percent;
      if v_trade.tp3_done then return jsonb_build_object('ok',false,'reason','TP3_ALREADY_DONE'); end if;
    end if;
    if v_target is null or v_percent is null or v_percent <= 0
       or not (
         (v_trade.side = 'BUY' and p_exit_price >= v_target)
         or (v_trade.side = 'SELL' and p_exit_price <= v_target)
       ) then
      return jsonb_build_object('ok',false,'reason',p_stage || '_NOT_REACHED');
    end if;
    if p_stage = 'TP3' then
      v_qty := v_trade.remaining_quantity;
    else
      v_qty := least(v_trade.remaining_quantity, round(v_trade.quantity * v_percent / 100, 12));
    end if;
  end if;

  v_pnl := round(
    (case when v_trade.side = 'BUY' then p_exit_price - v_trade.entry_price
          else v_trade.entry_price - p_exit_price end)
    * v_qty * p_quote_to_usd, 2
  );
  v_remaining := greatest(0, v_trade.remaining_quantity - v_qty);
  v_closed := p_stage = 'STOP_LOSS' or v_remaining <= 0.000000000001;
  if v_closed then v_remaining := 0; end if;

  update public.demo_paper_trades
     set remaining_quantity = v_remaining,
         tp1_done = tp1_done or p_stage = 'TP1',
         tp2_done = tp2_done or p_stage = 'TP2',
         tp3_done = tp3_done or p_stage = 'TP3',
         realized_pnl_usd = realized_pnl_usd + v_pnl,
         last_mark_price = p_exit_price,
         last_mark_at = p_quote_as_of,
         status = case when v_closed then 'CLOSED' else 'OPEN' end,
         closed_at = case when v_closed then now() else null end
   where id = v_trade.id;

  update public.demo_paper_sessions
     set current_balance = greatest(0, current_balance + v_pnl),
         status = case
           when greatest(0, -(select coalesce(sum(realized_pnl_usd),0)
             from public.demo_paper_trades
             where user_id = p_user_id
               and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'))
             >= starting_balance * max_daily_loss_pct / 100
           then 'RISK_LOCKED' else status end,
         risk_locked_at = case
           when greatest(0, -(select coalesce(sum(realized_pnl_usd),0)
             from public.demo_paper_trades
             where user_id = p_user_id
               and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'))
             >= starting_balance * max_daily_loss_pct / 100
           then coalesce(risk_locked_at,now()) else risk_locked_at end,
         updated_at = now()
   where id = v_trade.session_id
   returning current_balance into v_balance;

  return jsonb_build_object(
    'ok',true,'stage',p_stage,'trade_id',v_trade.id,'closed',v_closed,
    'closed_units',v_qty,'remaining_units',v_remaining,
    'realized_pnl_this_stage',v_pnl,
    'realized_pnl_total',v_trade.realized_pnl_usd + v_pnl,
    'balance',v_balance,'trade_origin','MANUAL'
  );
end;
$$;

revoke all on function public.open_demo_manual_partial_trade(
 uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,
 numeric,numeric,numeric,numeric,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.open_demo_manual_partial_trade(
 uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,
 numeric,numeric,numeric,numeric,text,timestamptz
) to service_role;

revoke all on function public.manage_demo_manual_partial_exit(
 uuid,uuid,text,numeric,numeric,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.manage_demo_manual_partial_exit(
 uuid,uuid,text,numeric,numeric,text,timestamptz
) to service_role;

comment on function public.manage_demo_manual_partial_exit(uuid,uuid,text,numeric,numeric,text,timestamptz)
  is 'Permission-gated staged partial exits for MANUAL-origin DEMO virtual positions only. Each TP closes its configured percentage; SL closes the remaining quantity. Never sends broker orders.';
