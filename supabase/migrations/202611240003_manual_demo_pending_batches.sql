-- Pending, multi-position MANUAL DEMO batches.
-- A batch reserves aggregate risk while waiting for a verified price touch.
-- Activation inserts all child positions atomically at the planned entry price.
-- DEMO only: no broker orders are sent.

create table if not exists public.demo_manual_entry_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  instrument text not null,
  provider_symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  requested_trade_count integer not null check (requested_trade_count between 1 and 10),
  entry_price numeric(24,10) not null check (entry_price > 0),
  stop_loss numeric(24,10) not null check (stop_loss > 0),
  tp1_price numeric(24,10) not null check (tp1_price > 0),
  tp2_price numeric(24,10) not null check (tp2_price > 0),
  tp3_price numeric(24,10) not null check (tp3_price > 0),
  tp1_percent numeric(5,2) not null check (tp1_percent > 0),
  tp2_percent numeric(5,2) not null check (tp2_percent > 0),
  tp3_percent numeric(5,2) not null check (tp3_percent > 0),
  total_quantity numeric(28,12) not null check (total_quantity > 0),
  total_risk_usd numeric(18,2) not null check (total_risk_usd > 0),
  total_risk_pct numeric(5,2) not null check (total_risk_pct > 0 and total_risk_pct <= 2),
  quote_to_usd numeric(24,12) not null check (quote_to_usd > 0),
  quote_source text not null check (quote_source = 'DERIV'),
  last_quote numeric(24,10) not null check (last_quote > 0),
  last_quote_as_of timestamptz not null,
  status text not null default 'PENDING'
    check (status in ('PENDING','ACTIVE','CANCELLED','EXPIRED','BLOCKED','FAILED')),
  child_trade_ids uuid[] not null default '{}',
  expires_at timestamptz not null default (now() + interval '7 days'),
  activated_at timestamptz,
  terminal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (round(tp1_percent + tp2_percent + tp3_percent,2) = 100),
  check (
    (side='BUY' and stop_loss < entry_price and entry_price < tp1_price
      and tp1_price < tp2_price and tp2_price < tp3_price)
    or
    (side='SELL' and stop_loss > entry_price and entry_price > tp1_price
      and tp1_price > tp2_price and tp2_price > tp3_price)
  )
);

create index if not exists demo_manual_entry_batches_pending_idx
  on public.demo_manual_entry_batches(status,created_at)
  where status='PENDING';
create index if not exists demo_manual_entry_batches_owner_idx
  on public.demo_manual_entry_batches(user_id,status,created_at desc);

alter table public.demo_manual_entry_batches enable row level security;
drop policy if exists demo_manual_entry_batches_owner_read on public.demo_manual_entry_batches;
create policy demo_manual_entry_batches_owner_read
  on public.demo_manual_entry_batches for select to authenticated
  using (auth.uid() = user_id);
revoke all on public.demo_manual_entry_batches from anon,authenticated;
grant select on public.demo_manual_entry_batches to authenticated;
grant all on public.demo_manual_entry_batches to service_role;

create or replace function public.create_demo_manual_entry_batch(
 p_user_id uuid,p_session_id uuid,p_instrument text,p_provider_symbol text,p_side text,p_trade_count integer,
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
 v_daily_loss numeric;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_user_id is null or p_session_id is null or nullif(trim(p_instrument),'') is null
   or nullif(trim(p_provider_symbol),'') is null or p_side not in ('BUY','SELL') or p_trade_count is null or p_trade_count not between 1 and 10
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
   (p_side='BUY' and p_stop<p_entry and p_entry<p_tp1 and p_tp1<p_tp2 and p_tp2<p_tp3 and p_quote>p_entry)
   or
   (p_side='SELL' and p_stop>p_entry and p_entry>p_tp1 and p_tp1>p_tp2 and p_tp2>p_tp3 and p_quote<p_entry)
 ) then
   raise exception 'Entry must still be untouched; levels must be correctly ordered for the trade direction';
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

 v_daily_loss:=greatest(0,-coalesce((select sum(realized_pnl_usd)
   from public.demo_paper_trades where user_id=p_user_id
   and closed_at>=date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'),0));
 if v_daily_loss>=v_session.starting_balance*v_session.max_daily_loss_pct/100 then
   update public.demo_paper_sessions set status='RISK_LOCKED',risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now()
    where id=p_session_id;
   return jsonb_build_object('ok',false,'reason','DAILY_LOSS_LIMIT');
 end if;

 insert into public.demo_manual_entry_batches(
  user_id,session_id,instrument,provider_symbol,side,requested_trade_count,entry_price,stop_loss,
  tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,
  total_quantity,total_risk_usd,total_risk_pct,quote_to_usd,quote_source,
  last_quote,last_quote_as_of
 ) values (
  p_user_id,p_session_id,p_instrument,p_provider_symbol,p_side,p_trade_count,p_entry,p_stop,
  p_tp1,p_tp2,p_tp3,p_tp1_percent,p_tp2_percent,p_tp3_percent,
  p_total_quantity,p_total_risk_usd,p_total_risk_pct,p_quote_to_usd,p_quote_source,
  p_quote,p_quote_as_of
 ) returning id into v_id;

 return jsonb_build_object('ok',true,'batch_id',v_id,'status','PENDING',
  'trade_count',p_trade_count,'aggregate_risk_usd',p_total_risk_usd,
  'aggregate_risk_pct',p_total_risk_pct,'planned_entry',p_entry,'expires_at',now()+interval '7 days');
end;
$$;

create or replace function public.activate_demo_manual_entry_batch(
 p_batch_id uuid,p_quote numeric,p_quote_source text,p_provider_symbol text,p_quote_as_of timestamptz,p_quote_to_usd numeric
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_batch public.demo_manual_entry_batches%rowtype;
 v_session public.demo_paper_sessions%rowtype;
 v_open_count integer;
 v_open_risk numeric;
 v_other_pending_count integer;
 v_other_pending_risk numeric;
 v_daily_loss numeric;
 v_child_ids uuid[] := '{}';
 v_child_id uuid;
 v_i integer;
 v_qty numeric(28,12);
 v_total_quantity numeric(28,12);
 v_risk numeric(18,2);
 v_risk_pct numeric(5,2);
 v_balance numeric(18,2);
 v_triggered boolean;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_batch_id is null or p_quote is null or p_quote<=0
   or p_quote_source is distinct from 'DERIV' or nullif(trim(p_provider_symbol),'') is null or p_quote_as_of is null
   or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
   or p_quote_to_usd is null or p_quote_to_usd<=0 then
   raise exception 'Invalid or stale pending-entry activation quote';
 end if;

 select * into v_batch from public.demo_manual_entry_batches where id=p_batch_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','BATCH_NOT_FOUND'); end if;
 if v_batch.status<>'PENDING' then
   return jsonb_build_object('ok',v_batch.status='ACTIVE','reason','BATCH_NOT_PENDING','status',v_batch.status);
 end if;
 if p_quote_as_of<=v_batch.last_quote_as_of then
   return jsonb_build_object('ok',false,'activated',false,'reason','QUOTE_CHECKPOINT_NOT_NEWER');
 end if;
 if v_batch.expires_at<=now() then
   update public.demo_manual_entry_batches set status='EXPIRED',terminal_reason='PENDING_ENTRY_EXPIRED',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','BATCH_EXPIRED');
 end if;

 select * into v_session from public.demo_paper_sessions
  where id=v_batch.session_id and user_id=v_batch.user_id for update;
 if not found or v_session.status<>'RUNNING' or v_session.broker<>'DERIV' then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='SESSION_NOT_RUNNING',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','SESSION_NOT_RUNNING');
 end if;
 if v_session.current_balance<=0
   or v_batch.total_risk_usd>v_session.current_balance*v_session.risk_per_trade_pct/100 then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='SESSION_RISK_LIMIT_CHANGED',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','SESSION_RISK_LIMIT_CHANGED');
 end if;
 if upper(v_session.instrument)<>upper(v_batch.instrument) then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='INSTRUMENT_MISMATCH',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH');
 end if;
 if exists(select 1 from public.demo_paper_emergency_controls
   where user_id=v_batch.user_id and broker='DERIV'
     and broker_account_ref=v_session.broker_account_ref and entries_blocked)
   or exists(select 1 from public.bot_emergency_controls
     where user_id=v_batch.user_id and account_mode='DEMO' and broker='DERIV'
       and broker_account_ref=v_session.broker_account_ref and kill_switch_active) then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='EMERGENCY_STOP_ACTIVE',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','EMERGENCY_STOP_ACTIVE');
 end if;

 if p_provider_symbol is distinct from v_batch.provider_symbol
   or not exists(select 1 from public.trading_instrument_approvals
     where broker='DERIV' and instrument=v_batch.instrument and provider='DERIV'
       and provider_symbol=v_batch.provider_symbol and status='APPROVED' and is_active=true) then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='INSTRUMENT_APPROVAL_REVOKED',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_APPROVAL_REVOKED');
 end if;

 v_triggered := (v_batch.side='BUY' and v_batch.last_quote>v_batch.entry_price and p_quote<=v_batch.entry_price)
   or (v_batch.side='SELL' and v_batch.last_quote<v_batch.entry_price and p_quote>=v_batch.entry_price);
 if not v_triggered then
   update public.demo_manual_entry_batches
    set last_quote=p_quote,last_quote_as_of=p_quote_as_of,updated_at=now()
    where id=v_batch.id and status='PENDING';
   return jsonb_build_object('ok',true,'activated',false,'reason','ENTRY_NOT_TOUCHED');
 end if;

 select count(*),coalesce(sum(risk_amount_usd*remaining_quantity/nullif(quantity,0)),0)
 into v_open_count,v_open_risk
 from public.demo_paper_trades
 where user_id=v_batch.user_id and session_id=v_batch.session_id and status='OPEN';
 select coalesce(sum(requested_trade_count),0),coalesce(sum(total_risk_usd),0)
 into v_other_pending_count,v_other_pending_risk
 from public.demo_manual_entry_batches
 where user_id=v_batch.user_id and session_id=v_batch.session_id and status='PENDING'
  and id<>v_batch.id and expires_at>now();
 if v_open_count+v_batch.requested_trade_count+v_other_pending_count>v_session.max_open_positions then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='MAX_OPEN_POSITIONS_AT_ACTIVATION',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','MAX_OPEN_POSITIONS_AT_ACTIVATION');
 end if;
 if v_open_risk+v_batch.total_risk_usd+v_other_pending_risk >
   v_session.current_balance*v_session.max_total_open_risk_pct/100+0.000001 then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='TOTAL_OPEN_RISK_LIMIT_AT_ACTIVATION',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','TOTAL_OPEN_RISK_LIMIT_AT_ACTIVATION');
 end if;
 v_daily_loss:=greatest(0,-coalesce((select sum(realized_pnl_usd) from public.demo_paper_trades
  where user_id=v_batch.user_id and closed_at>=date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'),0));
 if v_daily_loss>=v_session.starting_balance*v_session.max_daily_loss_pct/100 then
   update public.demo_paper_sessions set status='RISK_LOCKED',risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now() where id=v_session.id;
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='DAILY_LOSS_LIMIT_AT_ACTIVATION',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','DAILY_LOSS_LIMIT_AT_ACTIVATION');
 end if;

 v_balance:=v_session.current_balance;
 v_total_quantity:=round(v_batch.total_risk_usd/(abs(v_batch.entry_price-v_batch.stop_loss)*p_quote_to_usd),12);
 if v_total_quantity<=0 or v_total_quantity>1000000000000
   or round(v_total_quantity/v_batch.requested_trade_count,12)<=0 then
   update public.demo_manual_entry_batches set status='BLOCKED',terminal_reason='ACTIVATION_SIZE_OUT_OF_RANGE',updated_at=now() where id=v_batch.id;
   return jsonb_build_object('ok',false,'reason','ACTIVATION_SIZE_OUT_OF_RANGE');
 end if;
 v_qty:=round(v_total_quantity/v_batch.requested_trade_count,12);
 v_risk:=trunc(v_batch.total_risk_usd/v_batch.requested_trade_count,2);
 v_risk_pct:=greatest(0.01,round(v_risk/v_balance*100,2));
 for v_i in 1..v_batch.requested_trade_count loop
   if v_i=v_batch.requested_trade_count then
     v_qty:=v_total_quantity-(round(v_total_quantity/v_batch.requested_trade_count,12)*(v_batch.requested_trade_count-1));
     v_risk:=v_batch.total_risk_usd-(trunc(v_batch.total_risk_usd/v_batch.requested_trade_count,2)*(v_batch.requested_trade_count-1));
   else
     v_qty:=round(v_total_quantity/v_batch.requested_trade_count,12);
     v_risk:=trunc(v_batch.total_risk_usd/v_batch.requested_trade_count,2);
   end if;
   v_risk_pct:=greatest(0.01,round(v_risk/v_balance*100,2));
   insert into public.demo_paper_trades(
    session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
    tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,
    quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
    quote_source,quote_as_of,trade_origin,metadata
   ) values (
    v_batch.session_id,v_batch.user_id,v_batch.instrument,v_batch.side,v_batch.entry_price,
    v_batch.stop_loss,v_batch.tp3_price,v_batch.tp1_price,v_batch.tp2_price,v_batch.tp3_price,
    v_batch.tp1_percent,v_batch.tp2_percent,v_batch.tp3_percent,
    v_qty,v_qty,v_risk,v_risk_pct,p_quote_to_usd,'DERIV',p_quote_as_of,'MANUAL',
    jsonb_build_object('manual_entry_batch_id',v_batch.id,'batch_trade_number',v_i,
      'batch_trade_count',v_batch.requested_trade_count,'planned_entry_price',v_batch.entry_price,
      'simulated_fill',true,'trigger_quote',p_quote,'trigger_quote_as_of',p_quote_as_of)
   ) returning id into v_child_id;
   v_child_ids:=array_append(v_child_ids,v_child_id);
 end loop;

 update public.demo_manual_entry_batches
  set status='ACTIVE',total_quantity=v_total_quantity,quote_to_usd=p_quote_to_usd,
      total_risk_pct=round(v_batch.total_risk_usd/v_balance*100,2),
      child_trade_ids=v_child_ids,activated_at=now(),updated_at=now()
  where id=v_batch.id and status='PENDING';
 if not found then raise exception 'Pending batch activation state changed unexpectedly'; end if;
 return jsonb_build_object('ok',true,'activated',true,'batch_id',v_batch.id,
  'trade_ids',v_child_ids,'trade_count',cardinality(v_child_ids),
  'planned_entry',v_batch.entry_price,'trigger_quote',p_quote,
  'aggregate_risk_usd',v_batch.total_risk_usd);
end;
$$;

create or replace function public.cancel_demo_manual_entry_batch(
 p_user_id uuid,p_batch_id uuid,p_terminal_status text default 'CANCELLED',p_reason text default null
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_batch public.demo_manual_entry_batches%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_terminal_status not in ('CANCELLED','BLOCKED','EXPIRED') then raise exception 'Invalid terminal state'; end if;
 select * into v_batch from public.demo_manual_entry_batches
  where id=p_batch_id and user_id=p_user_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','BATCH_NOT_FOUND'); end if;
 if v_batch.status<>'PENDING' then return jsonb_build_object('ok',false,'reason','BATCH_NOT_PENDING','status',v_batch.status); end if;
 update public.demo_manual_entry_batches
  set status=p_terminal_status,terminal_reason=left(coalesce(p_reason,p_terminal_status),120),updated_at=now()
  where id=v_batch.id and status='PENDING';
 return jsonb_build_object('ok',true,'status',p_terminal_status,'batch_id',v_batch.id);
end;
$$;

revoke all on function public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz)
 from public,anon,authenticated;
revoke all on function public.activate_demo_manual_entry_batch(uuid,numeric,text,text,timestamptz,numeric)
 from public,anon,authenticated;
revoke all on function public.cancel_demo_manual_entry_batch(uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.create_demo_manual_entry_batch(uuid,uuid,text,text,text,integer,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,timestamptz)
 to service_role;
grant execute on function public.activate_demo_manual_entry_batch(uuid,numeric,text,text,timestamptz,numeric)
 to service_role;
grant execute on function public.cancel_demo_manual_entry_batch(uuid,uuid,text,text)
 to service_role;

comment on table public.demo_manual_entry_batches is
 'DEMO-only pending manual multi-position setups. Aggregate risk is reserved while pending; child virtual positions are inserted atomically only after a verified price crossing.';


-- Prevent ordinary BOT/manual opens from consuming slots or risk already
-- reserved by pending batches. Batch activation inserts carry the batch id and
-- are checked atomically by activate_demo_manual_entry_batch itself.
create or replace function public.guard_demo_pending_batch_reservations()
returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_session public.demo_paper_sessions%rowtype;
 v_open_count integer;
 v_open_risk numeric;
 v_pending_count integer;
 v_pending_risk numeric;
begin
 if new.metadata ? 'manual_entry_batch_id' then return new; end if;
 select * into v_session from public.demo_paper_sessions
  where id=new.session_id and user_id=new.user_id for update;
 if not found then raise exception 'DEMO session not found for pending reservation check'; end if;
 select count(*),coalesce(sum(risk_amount_usd*remaining_quantity/nullif(quantity,0)),0)
  into v_open_count,v_open_risk
  from public.demo_paper_trades
  where user_id=new.user_id and session_id=new.session_id and status='OPEN';
 select coalesce(sum(requested_trade_count),0),coalesce(sum(total_risk_usd),0)
  into v_pending_count,v_pending_risk
  from public.demo_manual_entry_batches
  where user_id=new.user_id and session_id=new.session_id and status='PENDING' and expires_at>now();
 if v_open_count+v_pending_count+1>v_session.max_open_positions then
  raise exception 'Pending manual batch reservations leave insufficient open-position slots';
 end if;
 if v_open_risk+v_pending_risk+new.risk_amount_usd >
   v_session.current_balance*v_session.max_total_open_risk_pct/100+0.000001 then
  raise exception 'Pending manual batch reservations leave insufficient aggregate risk capacity';
 end if;
 return new;
end;
$$;

drop trigger if exists demo_paper_respect_pending_manual_batches on public.demo_paper_trades;
create trigger demo_paper_respect_pending_manual_batches
 before insert on public.demo_paper_trades
 for each row execute function public.guard_demo_pending_batch_reservations();

revoke all on function public.guard_demo_pending_batch_reservations() from public,anon,authenticated;
grant execute on function public.guard_demo_pending_batch_reservations() to service_role;
