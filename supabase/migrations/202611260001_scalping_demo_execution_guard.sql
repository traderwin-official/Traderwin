-- Add a server-only entry guard for the Quantum Scalping DEMO paper adapter.
-- It layers stricter scalping limits over the shared DEMO paper ledger without
-- changing legacy sessions, manual positions, or any REAL account path.

alter table public.demo_scalping_preferences
  add column if not exists last_candle_as_of timestamptz;

create or replace function public.open_demo_scalping_paper_trade(
  p_user_id uuid,
  p_session_id uuid,
  p_instrument text,
  p_side text,
  p_entry numeric,
  p_stop numeric,
  p_target numeric,
  p_tp1 numeric,
  p_tp2 numeric,
  p_tp3 numeric,
  p_quantity numeric,
  p_risk_amount numeric,
  p_risk_pct numeric,
  p_quote_to_usd numeric,
  p_quote_as_of timestamptz,
  p_candle_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_paper_sessions%rowtype;
  v_preference public.demo_scalping_preferences%rowtype;
  v_daily_loss numeric(18,2);
  v_daily_limit numeric(18,2);
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_user_id is null or p_session_id is null
     or p_instrument is null or nullif(trim(p_instrument),'') is null
     or p_side is null or p_side not in ('BUY','SELL')
     or p_entry is null or p_entry <= 0
     or p_stop is null or p_stop <= 0
     or p_target is null or p_target <= 0
     or p_tp1 is null or p_tp1 <= 0
     or p_tp2 is null or p_tp2 <= 0
     or p_tp3 is null or p_tp3 <= 0
     or p_quantity is null or p_quantity <= 0
     or p_risk_amount is null or p_risk_amount <= 0
     or p_risk_pct is null or p_risk_pct <= 0 or p_risk_pct > 0.25
     or p_quote_to_usd is null or p_quote_to_usd <= 0
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds'
     or p_candle_as_of is null or p_candle_as_of > now()
     or p_candle_as_of < now() - interval '2 minutes' then
    raise exception 'Invalid, stale, or over-risk scalping DEMO entry';
  end if;

  if not (
    (p_side = 'BUY' and p_stop < p_entry and p_entry < p_tp1 and p_tp1 < p_tp2 and p_tp2 < p_tp3
      and p_target = p_tp3)
    or
    (p_side = 'SELL' and p_stop > p_entry and p_entry > p_tp1 and p_tp1 > p_tp2 and p_tp2 > p_tp3
      and p_target = p_tp3)
  ) then
    raise exception 'Invalid scalping stop or staged target order';
  end if;

  select * into v_session
    from public.demo_paper_sessions
   where id = p_session_id and user_id = p_user_id
   for update;
  if not found or v_session.broker <> 'DERIV'
     or v_session.status <> 'RUNNING'
     or upper(v_session.instrument) <> upper(p_instrument)
     or v_session.config_snapshot->>'account_mode' is distinct from 'DEMO'
     or coalesce(v_session.config_snapshot->>'execution','') not in ('WEBSITE_PAPER_ONLY','WEBSITE_DEMO_AUTO_PAPER_ONLY') then
    return jsonb_build_object('ok',false,'reason','ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED');
  end if;

  select * into v_preference
    from public.demo_scalping_preferences
   where session_id = p_session_id and user_id = p_user_id
   for update;
  if not found or v_preference.enabled is not true
     or v_preference.account_mode <> 'DEMO'
     or v_preference.execution <> 'WEBSITE_PAPER_ONLY'
     or v_preference.max_risk_per_trade_pct > 0.25
     or v_preference.max_daily_loss_pct > 1.00
     or v_preference.max_open_positions <> 1 then
    return jsonb_build_object('ok',false,'reason','SCALPING_DEMO_OPT_IN_REQUIRED');
  end if;

  if p_candle_as_of <= coalesce(v_preference.last_candle_as_of,'epoch'::timestamptz) then
    return jsonb_build_object('ok',false,'reason','SCALPING_CANDLE_ALREADY_PROCESSED');
  end if;

  if p_risk_pct > v_preference.max_risk_per_trade_pct
     or p_risk_amount > v_session.current_balance * v_preference.max_risk_per_trade_pct / 100
     or abs(p_risk_amount - abs(p_entry - p_stop) * p_quantity * p_quote_to_usd) > 0.02 then
    raise exception 'Scalping DEMO position exceeds the approved risk budget';
  end if;

  v_daily_limit := v_session.starting_balance * least(v_preference.max_daily_loss_pct,1.00) / 100;
  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = p_user_id
     and realized_at >= date_trunc('day',now() at time zone 'Africa/Nairobi')
       at time zone 'Africa/Nairobi';

  if v_daily_loss >= v_daily_limit then
    update public.demo_paper_sessions
       set status = 'RISK_LOCKED',
           risk_locked_at = coalesce(risk_locked_at,now()),
           updated_at = now()
     where id = p_session_id;
    return jsonb_build_object('ok',false,'reason','SCALPING_DAILY_LOSS_LIMIT',
      'daily_loss_usd',v_daily_loss,'daily_limit_usd',v_daily_limit);
  end if;

  -- Scalping is deliberately limited to one open position across the user's
  -- DEMO paper account, including any existing manual position.
  if exists (
    select 1 from public.demo_paper_trades
     where user_id = p_user_id and status = 'OPEN'
  ) then
    return jsonb_build_object('ok',false,'reason','SCALPING_ONE_OPEN_POSITION_LIMIT');
  end if;

  update public.demo_scalping_preferences
     set last_candle_as_of = p_candle_as_of, updated_at = now()
   where session_id = p_session_id and user_id = p_user_id;

  v_result := public.open_demo_paper_trade(
    p_user_id,p_session_id,p_instrument,p_side,p_entry,p_stop,p_target,
    p_quantity,p_risk_amount,p_risk_pct,p_quote_to_usd,
    'DERIV',p_quote_as_of,'BOT',p_candle_as_of,p_tp1,p_tp2,p_tp3
  );

  if coalesce((v_result->>'ok')::boolean,false) is true then
    update public.demo_paper_trades
       set metadata = coalesce(metadata,'{}'::jsonb) ||
         jsonb_build_object('strategy','TIGER_SCHEME_QUANTUM_SCALPING',
                            'scalping_candle_as_of',p_candle_as_of)
     where id = (v_result->>'trade_id')::uuid
       and user_id = p_user_id
       and trade_origin = 'BOT'
       and status = 'OPEN';
  end if;

  return v_result || jsonb_build_object('execution_mode','DEMO_PAPER_ONLY');
end;
$$;

revoke all on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) to service_role;

comment on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) is 'Service-role-only scalping DEMO paper entry: explicit opt-in, fresh Deriv quote, one open position, candle idempotency, max 0.25% risk and max 1% daily loss. Never sends a broker order.';
