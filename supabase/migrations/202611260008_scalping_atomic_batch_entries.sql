-- Atomic batch entry for Quantum Scalping.
-- A single validated market opportunity may fill every available portfolio slot
-- in one transaction. All positions share one signal/tick but retain independent
-- quantities, risk, stops, targets and ledger rows. DEMO paper only.

create table if not exists public.demo_scalping_entry_batches (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  user_id uuid not null,
  entry_key text not null check (length(trim(entry_key)) between 1 and 160),
  entry_as_of timestamptz not null,
  trade_ids jsonb not null default '[]'::jsonb,
  opened_count integer not null default 0 check (opened_count between 0 and 15),
  batch_risk_usd numeric(18,2) not null default 0 check (batch_risk_usd >= 0),
  created_at timestamptz not null default now(),
  unique(session_id,entry_key)
);
create index if not exists demo_scalping_entry_batches_user_created_idx
  on public.demo_scalping_entry_batches(user_id,created_at desc);
alter table public.demo_scalping_entry_batches enable row level security;
revoke all on public.demo_scalping_entry_batches from public,anon,authenticated,service_role;

create or replace function public.open_demo_scalping_paper_trade_batch(
  p_user_id uuid,
  p_session_id uuid,
  p_entries jsonb,
  p_entry_as_of timestamptz,
  p_entry_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_paper_sessions%rowtype;
  v_preference public.demo_scalping_preferences%rowtype;
  v_entry record;
  v_entry_count integer;
  v_open_count integer;
  v_open_risk numeric(18,2);
  v_batch_risk numeric(18,2) := 0;
  v_daily_loss numeric(18,2);
  v_daily_limit numeric(18,2);
  v_total_risk_limit numeric(18,2);
  v_max_positions integer;
  v_ids jsonb := '[]'::jsonb;
  v_id uuid;
  v_batch_id uuid;
  v_index integer := 0;
  v_instrument text;
  v_side text;
  v_candle_latest timestamptz := 'epoch'::timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_user_id is null or p_session_id is null
     or p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 or jsonb_array_length(p_entries) > 15
     or p_entry_as_of is null or p_entry_as_of > now() + interval '2 seconds'
     or p_entry_as_of < now() - interval '10 seconds'
     or p_entry_key is null or length(trim(p_entry_key)) not between 1 and 160 then
    raise exception 'Invalid Quantum Scalping batch request';
  end if;
  v_entry_count := jsonb_array_length(p_entries);

  -- One portfolio lock serializes competing batches and manual/other BOT exposure.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_session
    from public.demo_paper_sessions
   where id=p_session_id and user_id=p_user_id
   for update;
  if not found or v_session.broker <> 'DERIV'
     or v_session.status <> 'RUNNING'
     or v_session.config_snapshot->>'account_mode' is distinct from 'DEMO'
     or coalesce(v_session.config_snapshot->>'execution','') not in ('WEBSITE_PAPER_ONLY','WEBSITE_DEMO_AUTO_PAPER_ONLY') then
    return jsonb_build_object('ok',false,'reason','ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED');
  end if;
  if not exists (select 1 from public.trader_profiles where user_id=p_user_id and account_mode='DEMO') then
    return jsonb_build_object('ok',false,'reason','CURRENT_ACCOUNT_MODE_NOT_DEMO');
  end if;
  if exists (
    select 1 from public.demo_paper_emergency_controls e
     where e.user_id=p_user_id and e.broker='DERIV'
       and e.broker_account_ref=v_session.broker_account_ref and e.entries_blocked
  ) then
    return jsonb_build_object('ok',false,'reason','KILL_SWITCH_ACTIVE');
  end if;

  select * into v_preference
    from public.demo_scalping_preferences
   where session_id=p_session_id and user_id=p_user_id
   for update;
  if not found or v_preference.enabled is not true
     or v_preference.paper_execution_enabled is not true
     or v_preference.account_mode <> 'DEMO'
     or v_preference.execution <> 'WEBSITE_PAPER_ONLY'
     or v_preference.max_risk_per_trade_pct > 0.25
     or v_preference.max_daily_loss_pct > 1.00
     or v_preference.max_open_positions not between 1 and 15 then
    return jsonb_build_object('ok',false,'reason','SCALPING_DEMO_OPT_IN_REQUIRED');
  end if;
  if p_entry_key = coalesce(v_preference.last_entry_key,'') then
    return jsonb_build_object('ok',false,'reason','SCALPING_ENTRY_ALREADY_PROCESSED');
  end if;
  if p_entry_as_of <= coalesce(v_preference.last_entry_as_of,'epoch'::timestamptz)
     or p_entry_as_of < coalesce(v_preference.last_entry_as_of,'epoch'::timestamptz) + interval '1 second' then
    return jsonb_build_object('ok',false,'reason','SCALPING_ENTRY_RATE_LIMIT');
  end if;

  v_max_positions := least(v_preference.max_open_positions,v_session.max_open_positions,15);
  select count(*),
         coalesce(sum(risk_amount_usd * remaining_quantity / quantity),0)
    into v_open_count,v_open_risk
    from public.demo_paper_trades
   where user_id=p_user_id and status='OPEN';
  if v_open_count + v_entry_count > v_max_positions then
    return jsonb_build_object('ok',false,'reason','SCALPING_MAX_OPEN_POSITIONS',
      'open_positions',v_open_count,'requested_positions',v_entry_count,'max_open_positions',v_max_positions);
  end if;

  v_daily_limit := v_session.starting_balance * least(v_preference.max_daily_loss_pct,1.00) / 100;
  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id=p_user_id
     and realized_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  if v_daily_loss >= v_daily_limit then
    update public.demo_paper_sessions set status='RISK_LOCKED',
      risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now() where id=p_session_id;
    return jsonb_build_object('ok',false,'reason','SCALPING_DAILY_LOSS_LIMIT',
      'daily_loss_usd',v_daily_loss,'daily_limit_usd',v_daily_limit);
  end if;

  v_total_risk_limit := least(greatest(0,v_session.starting_balance * 0.01 - v_daily_loss),
    v_session.current_balance * v_session.max_total_open_risk_pct / 100);

  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      instrument text,side text,entry numeric,stop numeric,target numeric,
      tp1 numeric,tp2 numeric,tp3 numeric,quantity numeric,risk_amount numeric,
      risk_pct numeric,quote_to_usd numeric,quote_as_of timestamptz,candle_as_of timestamptz
    )
  loop
    v_index := v_index + 1;
    if v_index=1 then
      v_instrument := v_entry.instrument;
      v_side := v_entry.side;
    end if;
    if v_entry.instrument is null or upper(v_entry.instrument) <> upper(v_session.instrument)
       or upper(v_entry.instrument) <> upper(v_instrument)
       or v_entry.side is distinct from v_side or v_entry.side not in ('BUY','SELL')
       or v_entry.entry is null or v_entry.entry <= 0
       or v_entry.stop is null or v_entry.stop <= 0
       or v_entry.target is null or v_entry.target <= 0
       or v_entry.tp1 is null or v_entry.tp1 <= 0
       or v_entry.tp2 is null or v_entry.tp2 <= 0
       or v_entry.tp3 is null or v_entry.tp3 <= 0
       or v_entry.quantity is null or v_entry.quantity <= 0
       or v_entry.risk_amount is null or v_entry.risk_amount <= 0
       or v_entry.risk_pct is null or v_entry.risk_pct <= 0 or v_entry.risk_pct > 0.25
       or v_entry.quote_to_usd is null or v_entry.quote_to_usd <= 0 or v_entry.quote_to_usd > 1000000
       or v_entry.quote_as_of is null or v_entry.quote_as_of > now()
       or v_entry.quote_as_of < now() - interval '10 seconds'
       or v_entry.candle_as_of is null or v_entry.candle_as_of > now()
       or v_entry.candle_as_of < now() - interval '2 minutes' then
      raise exception 'Invalid, stale, or over-risk entry in Quantum Scalping batch';
    end if;
    if not (
      (v_entry.side='BUY' and v_entry.stop < v_entry.entry and v_entry.entry < v_entry.tp1 and v_entry.tp1 < v_entry.tp2 and v_entry.tp2 < v_entry.tp3 and v_entry.target=v_entry.tp3)
      or
      (v_entry.side='SELL' and v_entry.stop > v_entry.entry and v_entry.entry > v_entry.tp1 and v_entry.tp1 > v_entry.tp2 and v_entry.tp2 > v_entry.tp3 and v_entry.target=v_entry.tp3)
    ) then raise exception 'Invalid stop or target ladder in Quantum Scalping batch'; end if;
    if abs(v_entry.target-v_entry.entry)/abs(v_entry.entry-v_entry.stop)<1.5
       or abs(v_entry.target-v_entry.entry)/abs(v_entry.entry-v_entry.stop)>3.0
       or abs(abs(v_entry.tp1-v_entry.entry)/abs(v_entry.entry-v_entry.stop)-0.75)>0.01
       or abs(abs(v_entry.tp2-v_entry.entry)/abs(v_entry.entry-v_entry.stop)-1.10)>0.01 then
      raise exception 'Quantum Scalping batch target ladder violates approved R plan';
    end if;
    if v_entry.risk_pct > v_preference.max_risk_per_trade_pct
       or v_entry.risk_amount > v_session.current_balance*v_preference.max_risk_per_trade_pct/100
       or abs(v_entry.risk_pct-(v_entry.risk_amount/v_session.current_balance*100))>0.001
       or abs(v_entry.risk_amount-abs(v_entry.entry-v_entry.stop)*v_entry.quantity*v_entry.quote_to_usd)>0.02 then
      raise exception 'Quantum Scalping batch exceeds per-position risk budget';
    end if;
    v_batch_risk := v_batch_risk + v_entry.risk_amount;
    v_candle_latest := greatest(v_candle_latest,v_entry.candle_as_of);
  end loop;

  if not exists (
    select 1 from public.trading_instrument_approvals a
     where a.broker='DERIV' and a.provider='DERIV'
       and upper(a.instrument)=upper(v_instrument)
       and nullif(trim(a.provider_symbol),'') is not null
       and a.status='APPROVED' and a.is_active=true
       and a.approved_at is not null and a.approved_by is not null
  ) then return jsonb_build_object('ok',false,'reason','SCALPING_INSTRUMENT_NOT_APPROVED'); end if;

  if v_open_risk + v_batch_risk > v_total_risk_limit + 0.01 then
    return jsonb_build_object('ok',false,'reason','SCALPING_TOTAL_OPEN_RISK_LIMIT',
      'open_risk_usd',v_open_risk,'requested_batch_risk_usd',v_batch_risk,
      'portfolio_risk_limit_usd',v_total_risk_limit);
  end if;

  -- Durable idempotency: a retry cannot recreate a batch after a later batch
  -- has updated the preference's last-entry key.
  insert into public.demo_scalping_entry_batches(session_id,user_id,entry_key,entry_as_of)
  values(p_session_id,p_user_id,p_entry_key,p_entry_as_of)
  on conflict(session_id,entry_key) do nothing
  returning id into v_batch_id;
  if v_batch_id is null then
    return jsonb_build_object('ok',false,'reason','SCALPING_ENTRY_ALREADY_PROCESSED');
  end if;

  v_index := 0;
  for v_entry in
    select * from jsonb_to_recordset(p_entries) as x(
      instrument text,side text,entry numeric,stop numeric,target numeric,
      tp1 numeric,tp2 numeric,tp3 numeric,quantity numeric,risk_amount numeric,
      risk_pct numeric,quote_to_usd numeric,quote_as_of timestamptz,candle_as_of timestamptz
    )
  loop
    v_index := v_index + 1;
    insert into public.demo_paper_trades(
      session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
      tp1_price,tp2_price,tp3_price,quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
      quote_source,quote_as_of,candle_as_of,trade_origin,metadata
    ) values (
      p_session_id,p_user_id,v_entry.instrument,v_entry.side,v_entry.entry,v_entry.stop,v_entry.target,
      v_entry.tp1,v_entry.tp2,v_entry.tp3,v_entry.quantity,v_entry.quantity,v_entry.risk_amount,v_entry.risk_pct,v_entry.quote_to_usd,
      'DERIV',v_entry.quote_as_of,v_entry.candle_as_of,'BOT',
      jsonb_build_object('strategy','TIGER_SCHEME_QUANTUM_SCALPING',
        'scalping_candle_as_of',v_entry.candle_as_of,'scalping_entry_key',p_entry_key,
        'scalping_entry_as_of',p_entry_as_of,'scalping_batch_index',v_index,'scalping_batch_size',v_entry_count)
    ) returning id into v_id;
    v_ids := v_ids || jsonb_build_array(v_id);
  end loop;

  update public.demo_scalping_preferences
     set last_candle_as_of=greatest(coalesce(last_candle_as_of,'epoch'::timestamptz),v_candle_latest),
         last_entry_as_of=p_entry_as_of,last_entry_key=p_entry_key,updated_at=now()
   where session_id=p_session_id and user_id=p_user_id;

  update public.demo_scalping_entry_batches
     set trade_ids=v_ids,opened_count=v_entry_count,batch_risk_usd=v_batch_risk
   where id=v_batch_id;

  return jsonb_build_object('ok',true,'trade_ids',v_ids,'opened_count',v_entry_count,
    'batch_key',p_entry_key,'status','OPEN','instrument',v_instrument,'side',v_side,
    'batch_risk_usd',v_batch_risk,'execution_mode','DEMO_PAPER_ONLY');
end;
$$;

create or replace function public.open_demo_scalping_paper_trade_batch_with_lease(
  p_lease_token uuid,p_user_id uuid,p_session_id uuid,p_entries jsonb,
  p_entry_as_of timestamptz,p_entry_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease public.scalping_worker_leases%rowtype;
begin
  if auth.role() is distinct from 'service_role' or p_lease_token is null then
    raise exception 'Service role and current scalping worker lease required';
  end if;
  select * into v_lease from public.scalping_worker_leases
   where lease_key='global' for update;
  if not found or v_lease.lease_token is distinct from p_lease_token
     or v_lease.lease_until is null or v_lease.lease_until <= clock_timestamp() then
    return jsonb_build_object('ok',false,'reason','SCALPING_WORKER_LEASE_NOT_OWNED');
  end if;
  return public.open_demo_scalping_paper_trade_batch(
    p_user_id,p_session_id,p_entries,p_entry_as_of,p_entry_key
  );
end;
$$;

revoke all on function public.open_demo_scalping_paper_trade_batch(uuid,uuid,jsonb,timestamptz,text)
  from public,anon,authenticated,service_role;
revoke all on function public.open_demo_scalping_paper_trade_batch_with_lease(uuid,uuid,uuid,jsonb,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.open_demo_scalping_paper_trade_batch_with_lease(uuid,uuid,uuid,jsonb,timestamptz,text)
  to service_role;

comment on function public.open_demo_scalping_paper_trade_batch_with_lease(uuid,uuid,uuid,jsonb,timestamptz,text)
  is 'Atomic lease-fenced Quantum Scalping DEMO paper batch entry; opens up to all remaining portfolio slots in one transaction after aggregate risk checks.';
