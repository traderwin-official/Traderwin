-- Runs only in the disposable PostgreSQL CI database after migrations 001-003.
-- Exercises the actual atomic RPCs; no production Supabase data is used.
do $$
declare
  v_user uuid;
  v_session_risk uuid;
  v_session_count uuid;
  v_session_bot uuid;
  v_result jsonb;
  v_count integer;
  v_permission record;
  v_saved boolean;
  i integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into auth.users default values returning id into v_user;

  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
    max_open_positions,max_total_open_risk_pct
  ) values (
    v_user,'DERIV','DEMO:'||v_user,'EURUSD','MULTI_CONFIRMATION_V1','M15','RUNNING',
    10000,10000,1.00,2.00,3,2.00
  ) returning id into v_session_risk;

  -- First BOT position and one MANUAL position coexist in the same session.
  select public.open_demo_paper_trade(
    v_user,v_session_risk,'EURUSD','BUY',1.10000,1.09000,1.13000,
    10000,100,1.00,1,'DERIV',now(),'BOT',now(),1.11000,1.12000,1.13000
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected BOT position to open: %',v_result;
  end if;

  select public.open_demo_paper_trade(
    v_user,v_session_risk,'EURUSD','SELL',1.10000,1.11000,1.07000,
    10000,100,1.00,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected MANUAL position to coexist with BOT: %',v_result;
  end if;

  -- A second BOT is refused by the single strategy slot.
  select public.open_demo_paper_trade(
    v_user,v_session_risk,'EURUSD','BUY',1.10000,1.09000,1.13000,
    10000,100,1.00,1,'DERIV',now(),'BOT',now(),1.11000,1.12000,1.13000
  ) into v_result;
  if v_result->>'reason' <> 'BOT_POSITION_EXISTS' then
    raise exception 'Expected BOT_POSITION_EXISTS, got %',v_result;
  end if;

  -- Aggregate remaining risk prevents stacking individually valid entries
  -- beyond the session's 2% total open-risk budget.
  select public.open_demo_paper_trade(
    v_user,v_session_risk,'EURUSD','SELL',1.10000,1.11000,1.07000,
    10000,100,1.00,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if v_result->>'reason' <> 'TOTAL_OPEN_RISK_LIMIT' then
    raise exception 'Expected TOTAL_OPEN_RISK_LIMIT, got %',v_result;
  end if;
  select count(*) into v_count from public.demo_paper_trades
   where session_id=v_session_risk and status='OPEN';
  if v_count <> 2 then raise exception 'Expected exactly two open positions, got %',v_count; end if;

  -- Stop the first session so the one-active-session-per-user guard remains tested.
  update public.demo_paper_trades set status='CLOSED',remaining_quantity=0,closed_at=now()
   where session_id=v_session_risk and status='OPEN';
  update public.demo_paper_sessions set status='STOPPED',stopped_at=now() where id=v_session_risk;

  -- A separate session proves the configurable position-count cap.
  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
    max_open_positions,max_total_open_risk_pct
  ) values (
    v_user,'DERIV','DEMO:'||v_user,'EURUSD','MULTI_CONFIRMATION_V1','M15','RUNNING',
    10000,10000,1.00,2.00,2,5.00
  ) returning id into v_session_count;

  for i in 1..2 loop
    select public.open_demo_paper_trade(
      v_user,v_session_count,'EURUSD','BUY',1.10000,1.09000,1.13000,
      5000,50,0.50,1,'DERIV',now(),'MANUAL'
    ) into v_result;
    if coalesce((v_result->>'ok')::boolean,false) is not true then
      raise exception 'Expected position % to open: %',i,v_result;
    end if;
  end loop;

  select public.open_demo_paper_trade(
    v_user,v_session_count,'EURUSD','BUY',1.10000,1.09000,1.13000,
    5000,50,0.50,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if v_result->>'reason' <> 'MAX_OPEN_POSITIONS' then
    raise exception 'Expected MAX_OPEN_POSITIONS, got %',v_result;
  end if;

  -- Versioned portfolio-state writes are compare-and-swap, not blind upserts.
  select public.save_portfolio_profit_protection_state_v2(
    v_user,'DEMO','DERIV','DEMO:'||v_user,30,30,24,true,
    array['bot-1']::text[],jsonb_build_object('bot-1',jsonb_build_object('peakProfitPerUnitUsd',30,'units',1)),
    1,1,0,now(),'CI_DERIV_FEED',now()
  ) into v_saved;
  if v_saved is not true then raise exception 'Expected initial portfolio state insert'; end if;

  select public.save_portfolio_profit_protection_state_v2(
    v_user,'DEMO','DERIV','DEMO:'||v_user,40,35,32,true,
    array['bot-1']::text[],jsonb_build_object('bot-1',jsonb_build_object('peakProfitPerUnitUsd',40,'units',1)),
    1,2,0,now(),'CI_DERIV_FEED',now()
  ) into v_saved;
  if v_saved is not false then raise exception 'Expected stale portfolio state version to be rejected'; end if;

  select public.save_portfolio_profit_protection_state_v2(
    v_user,'DEMO','DERIV','DEMO:'||v_user,40,35,32,true,
    array['bot-1']::text[],jsonb_build_object('bot-1',jsonb_build_object('peakProfitPerUnitUsd',40,'units',1)),
    1,2,1,now(),'CI_DERIV_FEED',now()
  ) into v_saved;
  if v_saved is not true then raise exception 'Expected portfolio state version 2 update'; end if;

  insert into public.portfolio_trade_permissions(user_id,account_mode,broker,broker_account_ref)
  values(v_user,'DEMO','DERIV','DEMO:'||v_user)
  returning manual_trade_management,bot_trade_management,close_managed_positions,close_manual_trades
  into v_permission;
  if v_permission.manual_trade_management is not false
     or v_permission.bot_trade_management is not true
     or v_permission.close_managed_positions is not true
     or v_permission.close_manual_trades is not false then
    raise exception 'Unexpected default portfolio permissions: %',row_to_json(v_permission);
  end if;
end
$$;
