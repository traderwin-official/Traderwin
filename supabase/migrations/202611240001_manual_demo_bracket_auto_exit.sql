-- Permission-gated automatic SL/TP exits for manual-origin DEMO paper positions.
-- This is separate from portfolio giveback and never touches REAL broker positions.

alter table public.portfolio_trade_permissions
  add column if not exists auto_exit_manual_brackets boolean not null default false;

create or replace function public.close_demo_manual_trade_at_bracket(
  p_user_id uuid,
  p_trade_id uuid,
  p_exit_price numeric,
  p_quote_to_usd numeric,
  p_quote_source text,
  p_quote_as_of timestamptz,
  p_reason text
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
     or p_exit_price is null or p_exit_price <= 0
     or p_quote_to_usd is null or p_quote_to_usd <= 0
     or p_quote_source is distinct from 'DERIV'
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '30 seconds'
     or p_reason not in ('STOP_LOSS','TAKE_PROFIT') then
    raise exception 'Invalid or stale manual DEMO bracket close request';
  end if;

  select * into v_trade
    from public.demo_paper_trades
   where id = p_trade_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_FOUND');
  end if;
  if v_trade.status <> 'OPEN' then
    return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN');
  end if;
  if v_trade.trade_origin <> 'MANUAL' then
    return jsonb_build_object('ok',false,'reason','NOT_A_MANUAL_TRADE');
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
  if not found
     or v_permission.auto_exit_manual_brackets is not true then
    return jsonb_build_object('ok',false,'reason','MANUAL_BRACKET_CLOSE_PERMISSION_NOT_GRANTED');
  end if;

  if p_reason = 'STOP_LOSS' and not (
       (v_trade.side = 'BUY' and p_exit_price <= v_trade.stop_loss) or
       (v_trade.side = 'SELL' and p_exit_price >= v_trade.stop_loss)
  ) then
    return jsonb_build_object('ok',false,'reason','STOP_LOSS_NOT_REACHED');
  end if;
  if p_reason = 'TAKE_PROFIT' and not (
       (v_trade.side = 'BUY' and p_exit_price >= v_trade.take_profit) or
       (v_trade.side = 'SELL' and p_exit_price <= v_trade.take_profit)
  ) then
    return jsonb_build_object('ok',false,'reason','TAKE_PROFIT_NOT_REACHED');
  end if;

  v_result := public.close_demo_paper_trade(
    p_user_id,p_trade_id,p_exit_price,p_quote_to_usd,
    p_quote_source,p_quote_as_of,p_reason
  );
  return v_result || jsonb_build_object('reason',p_reason,'trade_origin','MANUAL');
end;
$$;

revoke all on function public.close_demo_manual_trade_at_bracket(uuid,uuid,numeric,numeric,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.close_demo_manual_trade_at_bracket(uuid,uuid,numeric,numeric,text,timestamptz,text)
  to service_role;

comment on function public.close_demo_manual_trade_at_bracket(uuid,uuid,numeric,numeric,text,timestamptz,text)
  is 'Closes only a MANUAL-origin DEMO paper position at its verified SL/TP bracket. Requires explicit manual management, manual close, and managed-position close permissions. Never sends broker orders.';
