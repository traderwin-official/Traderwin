-- Runs only in disposable PostgreSQL CI after DEMO ledger migrations 001-006
-- and 202611210001_demo_paper_daily_realization_events.sql.

do $$
declare
  v_user uuid;
  v_session uuid;
  v_trade uuid;
  v_result jsonb;
  v_status text;
  v_events integer;
  v_new_session uuid;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into auth.users default values returning id into v_user;

  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct
  ) values (
    v_user,'DERIV','DEMO:'||v_user,'EURUSD','MULTI_CONFIRMATION_V1','M15','RUNNING',
    10000,10000,1.00,2.00
  ) returning id into v_session;

  select public.open_demo_paper_trade(
    v_user,v_session,'EURUSD','BUY',1.10000,1.09000,1.13000,
    10000,100,1.00,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected DEMO paper position to open: %',v_result;
  end if;
  v_trade := (v_result->>'trade_id')::uuid;

  -- Simulate a realized partial loss update at the ledger boundary. The
  -- trigger must append the delta and lock the session atomically.
  update public.demo_paper_trades
     set realized_pnl_usd = -200.00
   where id = v_trade;

  select status into v_status from public.demo_paper_sessions where id=v_session;
  if v_status <> 'RISK_LOCKED' then
    raise exception 'Expected daily loss to lock the session, got %',v_status;
  end if;

  select count(*) into v_events from public.demo_paper_realized_events
   where user_id=v_user and trade_id=v_trade;
  if v_events <> 1 then
    raise exception 'Expected exactly one realization event, got %',v_events;
  end if;

  -- An update with no P&L change must not duplicate the event.
  update public.demo_paper_trades set last_mark_at=now() where id=v_trade;
  select count(*) into v_events from public.demo_paper_realized_events
   where user_id=v_user and trade_id=v_trade;
  if v_events <> 1 then
    raise exception 'A non-P&L update duplicated a realization event: %',v_events;
  end if;

  -- Even if the old session is stopped, a fresh session created on the same
  -- Nairobi trading day must be born risk-locked after the daily limit is hit.
  update public.demo_paper_sessions set status='STOPPED',stopped_at=now()
   where id=v_session;
  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct
  ) values (
    v_user,'DERIV','DEMO:'||v_user,'EURUSD','MULTI_CONFIRMATION_V1','M15','RUNNING',
    10000,10000,1.00,2.00
  ) returning id into v_new_session;

  select status into v_status from public.demo_paper_sessions where id=v_new_session;
  if v_status <> 'RISK_LOCKED' then
    raise exception 'New same-day session bypassed daily loss lock: %',v_status;
  end if;
end
$$;
