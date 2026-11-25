-- Upgrade pending manual DEMO entries to automatically detected STOP/LIMIT semantics.
-- Safe for databases where the previous pending-batch migration was already applied.
alter table public.demo_manual_entry_batches
  add column if not exists entry_type text not null default 'LIMIT' check (entry_type in ('LIMIT','STOP'));

-- Retire the old RPC signature. Older application code must fail closed rather than
-- create new batches with incomplete entry semantics during a rolling deployment.
do $ begin
 if to_regprocedure('public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz)') is not null then
  execute 'revoke all on function public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz) from public,anon,authenticated,service_role';
 end if;
end $;

create or replace function public.create_demo_manual_entry_batch(
 p_user_id uuid,p_session_id uuid,p_instrument text,p_provider_symbol text,p_side text,p_entry_type text,p_trade_count integer,
 p_entry numeric,p_stop numeric,p_tp1 numeric,p_tp2 numeric,p_tp3 numeric,
 p_tp1_percent numeric,p_tp2_percent numeric,p_tp3_percent numeric,
 p_total_quantity numeric,p_total_risk_usd numeric,p_total_risk_pct numeric,
 p_quote_to_usd numeric,p_quote_source text,p_quote numeric,p_quote_as_of timestamptz
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_session public.demo_paper_sessions%rowtype;
 v_open_count integer;
 v_open_risk numeric;
 v_pending_count integer;
 v_pending_risk numeric;
 v_id uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_user_id is null or p_session_id is null or nullif(trim(p_instrument),'') is null
   or nullif(trim(p_provider_symbol),'') is null or p_side not in ('BUY','SELL') or p_entry_type is null or p_entry_type not in ('LIMIT','STOP') or p_trade_count is null or p_trade_count not between 1 and 10
   or p_entry is null or p_entry<=0 or p_stop is null or p_stop<=0
   or p_tp1 is null or p_tp2 is null or p_tp3 is null
   or p_tp1<=0 or p_tp2<=0 or p_tp3<=0
   or p_tp1_percent is null or p_tp2_percent is null or p_tp3_percent is null
   or p_tp1_percent<=0 or p_tp2_percent<=0 or p_tp3_percent<=0
   or round(p_tp1_percent,2)<>p_tp1_percent or round(p_tp2_percent,2)<>p_tp2_percent
   or round(p_tp3_percent,2)<>p_tp3_percent
   or round(p_tp1_percent+p_tp2_percent+p_tp3_percent,2)<>100
   or p_total_quantity is null or p_total_quantity<=0
   or p_total_risk_usd is null or p_total_risk_usd<=0 or p_total_risk_usd<0.01*p_trade_count
   or p_total_risk_pct is null or p_total_risk_pct<=0 or p_total_risk_pct>2
   or p_quote_to_usd is null or p_quote_to_usd<=0
   or p_quote_source is distinct from 'DERIV'
   or p_quote is null or p_quote<=0
   or p_quote_as_of is null or p_quote_as_of>now()
   or p_quote_as_of<now()-interval '30 seconds' then
   raise exception 'Invalid or stale pending DEMO batch request';
 end if;
 if not (
   (p_side='BUY' and p_stop<p_entry and p_entry<p_tp1 and p_tp1<p_tp2 and p_tp2<p_tp3
     and ((p_entry_type='LIMIT' and p_quote>p_entry) or (p_entry_type='STOP' and p_quote<p_entry)))
   or
   (p_side='SELL' and p_stop>p_entry and p_entry>p_tp1 and p_tp1>p_tp2 and p_tp2>p_tp3
     and ((p_entry_type='LIMIT' and p_quote<p_entry) or (p_entry_type='STOP' and p_quote>p_entry)))
 ) then
   raise exception 'Entry type, quote side or trade levels are invalid';
 end if;
 if abs(p_total_risk_usd-abs(p_entry-p_stop)*p_total_quantity*p_quote_to_usd)>0.02 then
   raise exception 'Batch quantity and aggregate risk do not reconcile';
 end if;

 select * into v_session from public.demo_paper_sessions
  where id=p_session_id and user_id=p_user_id for update;
 if not found or v_session.status<>'RUNNING' or v_session.broker<>'DERIV' then
   return jsonb_build_object('ok',false,'reason','SESSION_NOT_RUNNING_OR_NOT_DERIV');
 end if;
 if upper(v_session.instrument)<>upper(p_instrument) then
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH');
 end if;
 if not exists(select 1 from public.trading_instrument_approvals
   where broker='DERIV' and instrument=p_instrument and provider='DERIV'
     and provider_symbol=p_provider_symbol and status='APPROVED' and is_active=true) then
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_NOT_APPROVED');
 end if;
 if p_total_risk_pct>v_session.risk_per_trade_pct
   or p_total_risk_usd>v_session.current_balance*v_session.risk_per_trade_pct/100 then
   return jsonb_build_object('ok',false,'reason','BATCH_RISK_EXCEEDS_SESSION_LIMIT');
 end if;
 if exists(select 1 from public.demo_paper_emergency_controls
   where user_id=p_user_id and broker='DERIV'
     and broker_account_ref=v_session.broker_account_ref and entries_blocked)
   or exists(select 1 from public.bot_emergency_controls
     where user_id=p_user_id and account_mode='DEMO' and broker='DERIV'
       and broker_account_ref=v_session.broker_account_ref and kill_switch_active) then
   return jsonb_build_object('ok',false,'reason','KILL_SWITCH_ACTIVE');
 end if;

 select count(*),coalesce(sum(risk_amount_usd*remaining_quantity/nullif(quantity,0)),0)
 into v_open_count,v_open_risk
 from public.demo_paper_trades
 where user_id=p_user_id and session_id=p_session_id and status='OPEN';

 select coalesce(sum(requested_trade_count),0),coalesce(sum(total_risk_usd),0)
 into v_pending_count,v_pending_risk
 from public.demo_manual_entry_batches
 where user_id=p_user_id and session_id=p_session_id and status='PENDING'
   and expires_at>now();

 if v_open_count+v_pending_count+p_trade_count>v_session.max_open_positions then
   return jsonb_build_object('ok',false,'reason','MAX_OPEN_POSITIONS',
     'available',greatest(0,v_session.max_open_positions-v_open_count-v_pending_count));
 end if;
 if v_open_risk+v_pending_risk+p_total_risk_usd >
   v_session.current_balance*v_session.max_total_open_risk_pct/100+0.000001 then
   return jsonb_build_object('ok',false,'reason','TOTAL_OPEN_RISK_LIMIT',
     'open_risk_usd',round(v_open_risk,2),'reserved_pending_risk_usd',round(v_pending_risk,2));
 end if;

 -- Daily account-equity protection is enforced by the later 20% guard migration.

 insert into public.demo_manual_entry_batches(
  user_id,session_id,instrument,provider_symbol,side,entry_type,requested_trade_count,entry_price,stop_loss,
  tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,
  total_quantity,total_risk_usd,total_risk_pct,quote_to_usd,quote_source,
  last_quote,last_quote_as_of
 ) values (
  p_user_id,p_session_id,p_instrument,p_provider_symbol,p_side,p_entry_type,p_trade_count,p_entry,p_stop,
  p_tp1,p_tp2,p_tp3,p_tp1_percent,p_tp2_percent,p_tp3_percent,
  p_total_quantity,p_total_risk_usd,p_total_risk_pct,p_quote_to_usd,p_quote_source,
  p_quote,p_quote_as_of
 ) returning id into v_id;

 return jsonb_build_object('ok',true,'batch_id',v_id,'status','PENDING',
  'trade_count',p_trade_count,'aggregate_risk_usd',p_total_risk_usd,
  'aggregate_risk_pct',p_total_risk_pct,'planned_entry',p_entry,'expires_at',now()+interval '7 days');
end;
$$;
revoke all on function public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz) from public,anon,authenticated;
grant execute on function public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz) to service_role;
