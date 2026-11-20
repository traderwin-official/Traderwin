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

revoke all on function public.close_demo_portfolio_trade(uuid,uuid,numeric,numeric,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.close_demo_portfolio_trade(uuid,uuid,numeric,numeric,text,timestamptz,text)
  to service_role;

comment on function public.close_demo_portfolio_trade(uuid,uuid,text,numeric,numeric,text,timestamptz,text)
  is 'Permission-locked, idempotent DEMO portfolio close. Manual positions require both monitoring and explicit close permission; no broker order is sent.';
