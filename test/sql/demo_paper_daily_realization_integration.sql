-- Disposable PostgreSQL integration for the fixed 20% DEMO daily account-equity guard.
-- Run only after the DEMO ledger and daily-equity migrations in CI.

do $$
declare
  v_user uuid;
  v_session uuid;
  v_new_session uuid;
  v_trade uuid;
  v_result jsonb;
  v_status text;
  v_events integer;
  v_baseline jsonb;
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

  -- The first valuation snapshots the Nairobi day's opening balance.
  select public.evaluate_demo_daily_loss_guard(v_user,0) into v_result;
  if coalesce((v_result->>'triggered')::boolean,true) then
    raise exception 'A new $10,000 account must begin below no loss threshold: %',v_result;
  end if;

  select public.open_demo_paper_trade(
    v_user,v_session,'EURUSD','BUY',1.10000,1.09000,1.13000,
    10000,100,1.00,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected first DEMO paper position to open: %',v_result;
  end if;
  v_trade := (v_result->>'trade_id')::uuid;

  -- Record a realized loss of $1,900. The realized-event trigger must append
  -- the event but must not invent a zero floating P/L and prematurely lock.
  update public.demo_paper_trades
     set realized_pnl_usd=-1900
   where id=v_trade;

  select count(*) into v_events from public.demo_paper_realized_events
   where user_id=v_user and trade_id=v_trade;
  if v_events<>1 then raise exception 'Expected one realization event, got %',v_events; end if;

  select public.get_demo_daily_opening_balance(v_user) into v_baseline;
  if (v_baseline->>'opening_balance_usd')::numeric<>10000 then
    raise exception 'Opening balance must be reconstructed as $10,000, got %',v_baseline;
  end if;

  -- $8,100 is above the $8,000 threshold and remains tradable.
  select public.evaluate_demo_daily_loss_guard(v_user,0) into v_result;
  if coalesce((v_result->>'triggered')::boolean,true)
     or (v_result->>'current_equity_usd')::numeric<>8100 then
    raise exception '$8,100 must remain above the 20%% threshold: %',v_result;
  end if;
  select status into v_status from public.demo_paper_sessions where id=v_session;
  if v_status<>'RUNNING' then
    raise exception 'A $1,900 realized loss alone must not lock while equity is $8,100; got %',v_status;
  end if;

  -- $100 of floating loss brings equity to exactly $8,000 and triggers.
  select public.evaluate_demo_daily_loss_guard(v_user,-100) into v_result;
  if coalesce((v_result->>'triggered')::boolean,false)
     or (v_result->>'current_equity_usd')::numeric<>8000 then
    raise exception 'Exactly 20%% drawdown must trigger: %',v_result;
  end if;
  select status into v_status from public.demo_paper_sessions where id=v_session;
  if v_status<>'RISK_LOCKED' then
    raise exception 'Expected account-wide session lock at $8,000, got %',v_status;
  end if;

  -- A later recovery must not clear the sticky daily lock.
  select public.evaluate_demo_daily_loss_guard(v_user,500) into v_result;
  if coalesce((v_result->>'triggered')::boolean,false) is not true then
    raise exception 'Once reached, the daily limit must remain locked until next Nairobi day: %',v_result;
  end if;

  -- Even if later manual losses drive the clamped virtual balance to zero,
  -- the next day's opening baseline must still reconstruct from the ledger.
  update public.demo_paper_trades set realized_pnl_usd=-12000 where id=v_trade;
  select public.get_demo_daily_opening_balance(v_user) into v_baseline;
  if (v_baseline->>'opening_balance_usd')::numeric<>10000 then
    raise exception 'Clamped account balance corrupted the day-opening baseline: %',v_baseline;
  end if;

  update public.demo_paper_sessions set status='STOPPED',stopped_at=now()
   where id=v_session;
  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct
  ) values (
    v_user,'DERIV','DEMO:'||v_user,'EURUSD','MULTI_CONFIRMATION_V1','M15','RUNNING',
    8100,8100,1.00,2.00
  ) returning id into v_new_session;
  select status into v_status from public.demo_paper_sessions where id=v_new_session;
  if v_status<>'RISK_LOCKED' then
    raise exception 'A new same-day session bypassed the sticky daily lock: %',v_status;
  end if;

  -- Every trade insertion route is blocked by the database guard, including
  -- a future batch activation RPC that inserts directly into the paper ledger.
  begin
    insert into public.demo_paper_trades(
      session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
      quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
      quote_source,quote_as_of,trade_origin
    ) values (
      v_new_session,v_user,'EURUSD','BUY',1.10000,1.09000,1.13000,
      1000,1000,10,1,1,'DERIV',now(),'BOT'
    );
    raise exception 'Daily lock failed to block direct trade insertion';
  exception when others then
    if sqlerrm not like '%DAILY_LOSS_LIMIT_REACHED%' then raise; end if;
  end;
end
$$;
