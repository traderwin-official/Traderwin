-- Pending manual DEMO batch integration tests. Run only in disposable CI PostgreSQL
-- after the complete isolated DEMO ledger and manual partial-exit migrations.
do $$
declare
 v_user uuid;
 v_user_cancel uuid;
 v_user_reserve uuid;
 v_session uuid;
 v_session_cancel uuid;
 v_session_reserve uuid;
 v_result jsonb;
 v_batch uuid;
 v_cancel_batch uuid;
 v_count integer;
 v_ids uuid[];
 v_failed boolean;
 i integer;
begin
 perform set_config('request.jwt.claim.role','service_role',true);
 insert into auth.users default values returning id into v_user;
 insert into public.trading_instrument_approvals(
  broker,instrument,provider,provider_symbol,status,is_active,approval_note,approved_by,updated_by,approved_at
 ) values('DERIV','EURUSD','DERIV','EURUSD','APPROVED',true,'Pending batch CI fixture',v_user,v_user,now());
 insert into public.demo_paper_sessions(
  user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
  starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
  max_open_positions,max_total_open_risk_pct
 ) values(v_user,'DERIV','PENDING:'||v_user,'EURUSD','MANUAL','M15','RUNNING',
  10000,10000,1.00,2.00,3,2.00) returning id into v_session;

 -- Create one pending two-position batch with one shared planned entry/SL/TP plan.
 select public.create_demo_manual_entry_batch(
  v_user,v_session,'EURUSD','EURUSD','BUY',2,
  1.10000,1.09000,1.11000,1.12000,1.13000,
  40,30,30,10000,100,1.00,1,'DERIV',1.10500,now()-interval '10 seconds'
 ) into v_result;
 if coalesce((v_result->>'ok')::boolean,false) is not true then
  raise exception 'Expected pending batch to be created: %',v_result;
 end if;
 v_batch:=(v_result->>'batch_id')::uuid;
 if v_result->>'status'<>'PENDING' or (v_result->>'trade_count')::integer<>2 then
  raise exception 'Unexpected pending batch response: %',v_result;
 end if;

 -- Pending batches reserve position slots before they activate.
 select public.create_demo_manual_entry_batch(
  v_user,v_session,'EURUSD','EURUSD','BUY',2,
  1.10000,1.09000,1.11000,1.12000,1.13000,
  40,30,30,5000,50,0.50,1,'DERIV',1.10500,now()
 ) into v_result;
 if v_result->>'reason'<>'MAX_OPEN_POSITIONS' then
  raise exception 'Expected pending slot reservation to reject an over-sized second batch: %',v_result;
 end if;

 -- A fresh quote still above the BUY limit only refreshes the checkpoint.
 select public.activate_demo_manual_entry_batch(v_batch,1.10200,'DERIV','EURUSD',now()-interval '5 seconds',1)
 into v_result;
 if coalesce((v_result->>'activated')::boolean,true) is not false
   or v_result->>'reason'<>'ENTRY_NOT_TOUCHED' then
  raise exception 'Expected untouched entry to remain pending: %',v_result;
 end if;

 -- The next fresh quote crosses the entry. Both child positions must appear atomically.
 select public.activate_demo_manual_entry_batch(v_batch,1.09900,'DERIV','EURUSD',now(),1)
 into v_result;
 if coalesce((v_result->>'activated')::boolean,false) is not true
   or (v_result->>'trade_count')::integer<>2 then
  raise exception 'Expected two child positions after touch: %',v_result;
 end if;
 select array_agg(x::uuid) into v_ids
 from jsonb_array_elements_text(v_result->'trade_ids') as t(x);
 select count(*) into v_count from public.demo_paper_trades
  where id=any(v_ids) and user_id=v_user and session_id=v_session and status='OPEN'
   and trade_origin='MANUAL' and entry_price=1.10000 and stop_loss=1.09000
   and tp1_price=1.11000 and tp2_price=1.12000 and tp3_price=1.13000
   and tp1_percent=40 and tp2_percent=30 and tp3_percent=30
   and metadata->>'manual_entry_batch_id'=v_batch::text;
 if v_count<>2 then raise exception 'Expected two identical shared-plan child positions, got %',v_count; end if;

 -- Repeated activation cannot duplicate children.
 select public.activate_demo_manual_entry_batch(v_batch,1.09800,'DERIV','EURUSD',now(),1)
 into v_result;
 select count(*) into v_count from public.demo_paper_trades
  where session_id=v_session and status='OPEN' and trade_origin='MANUAL';
 if v_count<>2 then raise exception 'Activation retry created duplicate children: %',v_count; end if;

 -- SELL pending entries activate only after a fresh quote crosses upward.
 select public.create_demo_manual_entry_batch(
  v_user,v_session,'EURUSD','EURUSD','SELL',1,
  1.10000,1.11000,1.09000,1.08000,1.07000,
  40,30,30,5000,50,0.50,1,'DERIV',1.09500,now()-interval '5 seconds'
 ) into v_result;
 if coalesce((v_result->>'ok')::boolean,false) is not true then
  raise exception 'Expected SELL pending batch: %',v_result;
 end if;
 v_cancel_batch:=(v_result->>'batch_id')::uuid;
 select public.activate_demo_manual_entry_batch(v_cancel_batch,1.10100,'DERIV','EURUSD',now(),1)
 into v_result;
 if coalesce((v_result->>'activated')::boolean,false) is not true
   or (v_result->>'trade_count')::integer<>1 then
  raise exception 'Expected SELL batch to activate after upward touch: %',v_result;
 end if;
 select count(*) into v_count from public.demo_paper_trades
  where session_id=v_session and side='SELL' and trade_origin='MANUAL'
    and entry_price=1.10000 and stop_loss=1.11000 and tp1_price=1.09000;
 if v_count<>1 then raise exception 'Expected one SELL child with shared pending levels'; end if;

 -- A user can cancel a still-pending batch; it creates no child positions.
 insert into auth.users default values returning id into v_user_cancel;
 insert into public.demo_paper_sessions(
  user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
  starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
  max_open_positions,max_total_open_risk_pct
 ) values(v_user_cancel,'DERIV','PENDING:'||v_user_cancel,'EURUSD','MANUAL','M15','RUNNING',
  10000,10000,1.00,2.00,3,2.00) returning id into v_session_cancel;
 select public.create_demo_manual_entry_batch(
  v_user_cancel,v_session_cancel,'EURUSD','EURUSD','SELL',1,
  1.10000,1.11000,1.09000,1.08000,1.07000,
  40,30,30,10000,100,1.00,1,'DERIV',1.09500,now()
 ) into v_result;
 v_cancel_batch:=(v_result->>'batch_id')::uuid;
 select public.cancel_demo_manual_entry_batch(v_user_cancel,v_cancel_batch,'CANCELLED','CI_CANCEL')
 into v_result;
 if coalesce((v_result->>'ok')::boolean,false) is not true or v_result->>'status'<>'CANCELLED' then
  raise exception 'Expected pending batch cancellation: %',v_result;
 end if;
 select count(*) into v_count from public.demo_paper_trades where session_id=v_session_cancel;
 if v_count<>0 then raise exception 'Cancelled pending batch created positions'; end if;

 -- Two pending batches reserve all 2% aggregate risk. A regular manual/BOT
 -- insert must not consume that already-reserved capacity.
 insert into auth.users default values returning id into v_user_reserve;
 insert into public.demo_paper_sessions(
  user_id,broker,broker_account_ref,instrument,strategy,timeframe,status,
  starting_balance,current_balance,risk_per_trade_pct,max_daily_loss_pct,
  max_open_positions,max_total_open_risk_pct
 ) values(v_user_reserve,'DERIV','PENDING:'||v_user_reserve,'EURUSD','MANUAL','M15','RUNNING',
  10000,10000,1.00,2.00,3,2.00) returning id into v_session_reserve;
 for i in 1..2 loop
  select public.create_demo_manual_entry_batch(
   v_user_reserve,v_session_reserve,'EURUSD','EURUSD','BUY',1,
   1.10000,1.09000,1.11000,1.12000,1.13000,
   40,30,30,10000,100,1.00,1,'DERIV',1.10500,now()
  ) into v_result;
  if coalesce((v_result->>'ok')::boolean,false) is not true then
   raise exception 'Expected risk reservation %: %',i,v_result;
  end if;
 end loop;
 v_failed:=false;
 begin
  perform public.open_demo_paper_trade(
   v_user_reserve,v_session_reserve,'EURUSD','BUY',1.10000,1.09000,1.13000,
   10000,100,1.00,1,'DERIV',now(),'MANUAL',null,1.11000,1.12000,1.13000
  );
 exception when others then
  if position('reservation' in lower(sqlerrm))>0 then v_failed:=true; else raise; end if;
 end;
 if not v_failed then raise exception 'Expected regular open to respect pending batch risk reservations'; end if;
end
$$;
