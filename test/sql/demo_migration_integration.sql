-- Runs only in the disposable PostgreSQL CI database after migrations 001-004.
-- Exercises the actual atomic RPCs; no production Supabase data is used.
create table if not exists public.trader_profiles(user_id uuid primary key,account_mode text not null);
do $body$
declare
  v_user uuid;
  v_scalping_user uuid;
  v_scalping_session uuid;
  v_scalping_trade uuid;
  v_session_risk uuid;
  v_session_count uuid;
  v_bot_trade_id uuid;
  v_manual_trade_id uuid;
  v_manual_portfolio_id uuid;
  v_result jsonb;
  v_count integer;
  v_permission record;
  v_saved boolean;
  i integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into auth.users default values returning id into v_user;
  insert into auth.users default values returning id into v_scalping_user;
  insert into public.trader_profiles(user_id,account_mode) values(v_scalping_user,'DEMO');

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
  v_bot_trade_id := (v_result->>'trade_id')::uuid;

  select public.open_demo_paper_trade(
    v_user,v_session_risk,'EURUSD','SELL',1.10000,1.11000,1.07000,
    10000,100,1.00,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected MANUAL position to coexist with BOT: %',v_result;
  end if;
  v_manual_trade_id := (v_result->>'trade_id')::uuid;

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

  -- TP1 must reduce remaining quantity while keeping the position OPEN.
  select public.manage_demo_paper_exit(
    v_user,v_bot_trade_id,'TP1',1.11000,1,'DERIV',now()
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true
     or coalesce((v_result->>'closed')::boolean,true) is not false
     or (v_result->>'remaining_units')::numeric <> 6000 then
    raise exception 'Expected atomic 40 percent TP1 partial close: %',v_result;
  end if;

  -- Both the BOT and MANUAL virtual positions must be closable at zero remainder.
  select public.close_demo_portfolio_trade(
    v_user,v_bot_trade_id,'EURUSD',1.10500,1,'DERIV',now(),'CI_BOT_PORTFOLIO_CLOSE_1'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected BOT portfolio close to succeed: %',v_result;
  end if;
  select public.close_demo_paper_trade(
    v_user,v_manual_trade_id,1.09500,1,'DERIV',now(),'MANUAL_CLOSE'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected MANUAL paper close to succeed: %',v_result;
  end if;
  select count(*) into v_count from public.demo_paper_trades
   where session_id=v_session_risk and status='OPEN';
  if v_count <> 0 then raise exception 'Expected both positions to be closed, got % open',v_count; end if;

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
    if i=1 then v_manual_portfolio_id := (v_result->>'trade_id')::uuid; end if;
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
    1,1,0,now(),'CI_DERIV_FEED',now()
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

  -- The database itself must reject manual portfolio closes until the owner
  -- explicitly grants both monitoring and close permission.
  select public.close_demo_portfolio_trade(
    v_user,v_manual_portfolio_id,'EURUSD',1.10500,1,'DERIV',now(),'CI_MANUAL_PORTFOLIO_CLOSE_1'
  ) into v_result;
  if v_result->>'reason' <> 'MANUAL_CLOSE_PERMISSION_NOT_GRANTED' then
    raise exception 'Expected manual portfolio close to be blocked: %',v_result;
  end if;

  update public.portfolio_trade_permissions
     set manual_trade_management=true,close_manual_trades=true,updated_at=now()
   where user_id=v_user and account_mode='DEMO' and broker='DERIV'
     and broker_account_ref='DEMO:'||v_user;

  select public.close_demo_portfolio_trade(
    v_user,v_manual_portfolio_id,'EURUSD',1.10500,1,'DERIV',now(),'CI_MANUAL_PORTFOLIO_CLOSE_1'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected explicitly authorized manual portfolio close: %',v_result;
  end if;


  -- Quantum Scalping must require a second, explicit paper-execution consent.
  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
    max_open_positions,max_total_open_risk_pct,config_snapshot
  ) values (
    v_scalping_user,'DERIV','DEMO:'||v_scalping_user,'EURUSD','TIGER_SCHEME_QUANTUM_SCALPING','M1','RUNNING',
    10000,10000,0.50,2.00,3,5.00,
    jsonb_build_object('account_mode','DEMO','execution','WEBSITE_PAPER_ONLY')
  ) returning id into v_scalping_session;

  insert into public.demo_scalping_preferences(
    session_id,user_id,enabled,paper_execution_enabled,account_mode,execution,
    max_risk_per_trade_pct,max_daily_loss_pct,max_open_positions
  ) values (
    v_scalping_session,v_scalping_user,true,true,'DEMO','WEBSITE_PAPER_ONLY',0.25,1.00,1
  );

  select public.open_demo_scalping_paper_trade(
    v_scalping_user,v_scalping_session,'EURUSD','BUY',
    1.10000,1.09000,1.11500,1.10750,1.11100,1.11500,
    2500,25,0.25,1,now(),now()-interval '1 minute'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected guarded scalping DEMO paper entry: %',v_result;
  end if;
  v_scalping_trade := (v_result->>'trade_id')::uuid;

  select public.open_demo_scalping_paper_trade(
    v_scalping_user,v_scalping_session,'EURUSD','BUY',
    1.10000,1.09000,1.11500,1.10750,1.11100,1.11500,
    2500,25,0.25,1,now(),now()-interval '1 minute'
  ) into v_result;
  if v_result->>'reason' <> 'SCALPING_CANDLE_ALREADY_PROCESSED' then
    raise exception 'Expected scalping candle idempotency: %',v_result;
  end if;

  update public.trader_profiles set account_mode='REAL' where user_id=v_scalping_user;
  select public.open_demo_scalping_paper_trade(
    v_scalping_user,v_scalping_session,'EURUSD','BUY',
    1.10000,1.09000,1.11500,1.10750,1.11100,1.11500,
    2500,25,0.25,1,now(),now()-interval '30 seconds'
  ) into v_result;
  if v_result->>'reason' <> 'CURRENT_ACCOUNT_MODE_NOT_DEMO' then
    raise exception 'Expected current REAL mode to block new DEMO scalping entries: %',v_result;
  end if;

  update public.trader_profiles set account_mode='DEMO' where user_id=v_scalping_user;
  update public.demo_scalping_preferences set paper_execution_enabled=false
   where session_id=v_scalping_session;
  select public.open_demo_scalping_paper_trade(
    v_scalping_user,v_scalping_session,'EURUSD','BUY',
    1.10000,1.09000,1.11500,1.10750,1.11100,1.11500,
    2500,25,0.25,1,now(),now()-interval '20 seconds'
  ) into v_result;
  if v_result->>'reason' <> 'SCALPING_DEMO_OPT_IN_REQUIRED' then
    raise exception 'Expected missing paper execution consent to block entries: %',v_result;
  end if;

  -- The trigger must prevent a manual paper entry from bypassing the cap
  -- while the already-open scalping position remains active.
  begin
    select public.open_demo_paper_trade(
      v_scalping_user,v_scalping_session,'EURUSD','SELL',1.10000,1.11000,1.07000,
      10000,10,0.10,1,'DERIV',now(),'MANUAL'
    ) into v_result;
    raise exception 'Expected the single-open-position trigger to reject a manual entry';
  exception when others then
    if position('Scalping DEMO enforces one open position' in sqlerrm)=0 then
      raise;
    end if;
  end;

  select public.close_demo_paper_trade(
    v_scalping_user,v_scalping_trade,1.10000,1,'DERIV',now(),'CI_SCALPING_CLOSE'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected scalping DEMO paper position to close: %',v_result;
  end if;

  -- A retry with the same request key must be idempotent and not realize P&L twice.
  select public.close_demo_portfolio_trade(
    v_user,v_manual_portfolio_id,'EURUSD',1.10500,1,'DERIV',now(),'CI_MANUAL_PORTFOLIO_CLOSE_1'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true
     or coalesce((v_result->>'already_closed')::boolean,false) is not true then
    raise exception 'Expected idempotent portfolio close retry: %',v_result;
  end if;
end
$body$;
