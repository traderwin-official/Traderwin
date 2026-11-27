-- Verify the unified DEMO risk guard in disposable CI PostgreSQL only.
do $$
declare
  v_user uuid;
  v_override_user uuid;
  v_batch_user uuid;
  v_session uuid;
  v_batch_session uuid;
  v_batch uuid;
  v_result jsonb;
  v_trade uuid;
  v_count integer;
  v_blocked boolean := false;
  i integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into auth.users default values returning id into v_user;

  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,max_open_positions
  ) values (
    v_user,'DERIV','RISK:'||v_user,'EURUSD','RISK_GUARD_CI','M15','RUNNING',
    10000,10000,10
  ) returning id into v_session;

  if (select risk_per_trade_pct from public.demo_paper_sessions where id=v_session) <> 0.25
     or (select max_daily_loss_pct from public.demo_paper_sessions where id=v_session) <> 1.00
     or (select max_total_open_risk_pct from public.demo_paper_sessions where id=v_session) <> 1.00 then
    raise exception 'New DEMO sessions must use the platform risk defaults';
  end if;

  -- Three positions consume 0.75% of starting equity.
  for i in 1..3 loop
    select public.open_demo_paper_trade(
      v_user,v_session,'EURUSD','BUY',1.10000,1.09000,1.13000,
      2500,25,0.25,1,'DERIV',now(),'MANUAL'
    ) into v_result;
    if coalesce((v_result->>'ok')::boolean,false) is not true then
      raise exception 'Expected compliant position % to open: %',i,v_result;
    end if;
    if i=1 then v_trade := (v_result->>'trade_id')::uuid; end if;
  end loop;

  -- Realize a 0.50% daily loss while positions remain open.
  update public.demo_paper_trades
     set realized_pnl_usd = -50
   where id=v_trade and status='OPEN';

  select count(*) into v_count
    from public.demo_paper_realized_events
   where user_id=v_user
     and realized_at >= date_trunc('day',now() at time zone 'Africa/Nairobi')
       at time zone 'Africa/Nairobi';
  if v_count = 0 then raise exception 'Expected realized-loss event to be recorded'; end if;

  -- Open risk (0.75%) + realized daily loss (0.50%) + new risk (0.25%)
  -- exceeds the combined 1% budget, even though open risk alone is exactly allowed.
  v_blocked := false;
  begin
    perform public.open_demo_paper_trade(
      v_user,v_session,'EURUSD','BUY',1.10000,1.09000,1.13000,
      2500,25,0.25,1,'DERIV',now(),'MANUAL'
    );
  exception when others then
    if position('combined daily loss' in lower(sqlerrm)) > 0 then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'Expected combined realized-loss and open-risk budget to block another entry';
  end if;

  -- A per-trade risk above 0.25% is blocked independently.
  v_blocked := false;
  begin
    perform public.open_demo_paper_trade(
      v_user,v_session,'EURUSD','BUY',1.10000,1.09000,1.13000,
      2600,26,0.26,1,'DERIV',now(),'MANUAL'
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'Expected risk above 0.25 percent per trade to be rejected'; end if;

  -- New sessions cannot opt out by explicitly requesting a higher risk cap.
  insert into auth.users default values returning id into v_override_user;
  v_blocked := false;
  begin
    insert into public.demo_paper_sessions(
      user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
      starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
      max_open_positions,max_total_open_risk_pct
    ) values (
      v_override_user,'DERIV','RISK-OVERRIDE:'||v_override_user,'EURUSD','RISK_GUARD_CI','M15','RUNNING',
      10000,10000,0.50,2.00,10,2.00
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'Expected session-level platform risk caps to reject overrides'; end if;

  -- Pending manual setups reserve the same combined daily-loss/open-risk budget.
  insert into auth.users default values returning id into v_batch_user;
  insert into public.trading_instrument_approvals(
    broker,instrument,provider,provider_symbol,status,is_active,
    approval_note,approved_by,updated_by,approved_at
  ) values (
    'DERIV','GBPUSD','DERIV','frxGBPUSD','APPROVED',true,
    'Disposable risk-budget CI fixture',v_batch_user,v_batch_user,now()
  );
  insert into public.demo_paper_sessions(
    user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
    starting_balance,current_balance,max_open_positions
  ) values (
    v_batch_user,'DERIV','RISK-BATCH:'||v_batch_user,'GBPUSD','RISK_GUARD_CI','M15','RUNNING',
    10000,10000,3
  ) returning id into v_batch_session;

  select public.open_demo_paper_trade(
    v_batch_user,v_batch_session,'GBPUSD','BUY',1.10000,1.09000,1.13000,
    2500,25,0.25,1,'DERIV',now(),'MANUAL'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected compliant GBPUSD position before pending reservation: %',v_result;
  end if;
  v_trade := (v_result->>'trade_id')::uuid;
  update public.demo_paper_trades set realized_pnl_usd=-50 where id=v_trade;

  select public.create_demo_manual_entry_batch(
    v_batch_user,v_batch_session,'GBPUSD','frxGBPUSD','BUY','LIMIT',1,
    1.10000,1.09000,1.11000,1.12000,1.13000,
    40,30,30,2500,25,0.25,1,'DERIV',1.10500,now()-interval '10 seconds'
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'Expected first pending reservation to fit the combined budget: %',v_result;
  end if;
  v_batch := (v_result->>'batch_id')::uuid;

  v_blocked := false;
  begin
    perform public.create_demo_manual_entry_batch(
      v_batch_user,v_batch_session,'GBPUSD','frxGBPUSD','BUY','LIMIT',1,
      1.10000,1.09000,1.11000,1.12000,1.13000,
      40,30,30,2500,25,0.25,1,'DERIV',1.10500,now()
    );
  exception when others then
    if position('combined daily loss' in lower(sqlerrm)) > 0 then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'Expected second pending reservation to exceed the combined DEMO budget';
  end if;
end
$$;
