-- Expand Quantum Scalping to a 15-position DEMO portfolio with a strict
-- aggregate open-risk ceiling. This migration is additive and is NOT applied
-- to production by this PR.

alter table public.demo_scalping_preferences
  alter column max_open_positions set default 15;
alter table public.demo_scalping_preferences
  drop constraint if exists demo_scalping_preferences_max_open_positions_check;
alter table public.demo_scalping_preferences
  add constraint demo_scalping_preferences_max_open_positions_check
  check (max_open_positions between 1 and 15);
update public.demo_scalping_preferences set max_open_positions=15,updated_at=now()
 where max_open_positions=1;

-- The underlying DEMO ledger also had a one-BOT-per-session unique index and
-- a 10-position session cap. Remove that obsolete runner restriction.
alter table public.demo_paper_sessions
  drop constraint if exists demo_paper_sessions_max_open_positions_check;
alter table public.demo_paper_sessions
  add constraint demo_paper_sessions_max_open_positions_check
  check (max_open_positions between 1 and 15);
update public.demo_paper_sessions
   set max_open_positions=15,updated_at=now()
 where strategy='TIGER_SCHEME_QUANTUM_SCALPING';
drop index if exists public.demo_paper_one_open_bot_trade_per_session;

-- The old ledger's global unique indexes made concurrent portfolio positions
-- impossible. The server-side RPCs below now enforce limits transactionally.
drop index if exists public.demo_paper_one_open_trade_per_session;
drop index if exists public.demo_paper_one_open_trade_per_user;
create index if not exists demo_paper_open_session_idx
  on public.demo_paper_trades(session_id,opened_at desc) where status='OPEN';
create index if not exists demo_paper_open_user_idx
  on public.demo_paper_trades(user_id,opened_at desc) where status='OPEN';

create or replace function public.open_demo_scalping_paper_trade(
  p_user_id uuid,
  p_session_id uuid,
  p_instrument text,
  p_side text,
  p_entry numeric,
  p_stop numeric,
  p_target numeric,
  p_tp1 numeric,
  p_tp2 numeric,
  p_tp3 numeric,
  p_quantity numeric,
  p_risk_amount numeric,
  p_risk_pct numeric,
  p_quote_to_usd numeric,
  p_quote_as_of timestamptz,
  p_candle_as_of timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_paper_sessions%rowtype;
  v_preference public.demo_scalping_preferences%rowtype;
  v_daily_loss numeric(18,2);
  v_daily_limit numeric(18,2);
  v_open_risk numeric(18,2);
  v_open_count integer;
  v_total_risk_limit numeric(18,2);
  v_result jsonb;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_user_id is null or p_session_id is null
     or p_instrument is null or nullif(trim(p_instrument),'') is null
     or p_side is null or p_side not in ('BUY','SELL')
     or p_entry is null or p_entry <= 0
     or p_stop is null or p_stop <= 0
     or p_target is null or p_target <= 0
     or p_tp1 is null or p_tp1 <= 0
     or p_tp2 is null or p_tp2 <= 0
     or p_tp3 is null or p_tp3 <= 0
     or p_quantity is null or p_quantity <= 0
     or p_risk_amount is null or p_risk_amount <= 0
     or p_risk_pct is null or p_risk_pct <= 0 or p_risk_pct > 0.25
     or p_quote_to_usd is null or p_quote_to_usd <= 0 or p_quote_to_usd > 1000000
     or p_quote_as_of is null or p_quote_as_of > now()
     or p_quote_as_of < now() - interval '10 seconds'
     or p_candle_as_of is null or p_candle_as_of > now()
     or p_candle_as_of < now() - interval '2 minutes' then
    raise exception 'Invalid, stale, or over-risk scalping DEMO entry';
  end if;

  if not (
    (p_side = 'BUY' and p_stop < p_entry and p_entry < p_tp1 and p_tp1 < p_tp2 and p_tp2 < p_tp3 and p_target = p_tp3)
    or
    (p_side = 'SELL' and p_stop > p_entry and p_entry > p_tp1 and p_tp1 > p_tp2 and p_tp2 > p_tp3 and p_target = p_tp3)
  ) then
    raise exception 'Invalid scalping stop or staged target order';
  end if;
  if abs(p_target-p_entry) / abs(p_entry-p_stop) < 1.5
     or abs(p_target-p_entry) / abs(p_entry-p_stop) > 3.0
     or abs(abs(p_tp1-p_entry) / abs(p_entry-p_stop) - 0.75) > 0.01
     or abs(abs(p_tp2-p_entry) / abs(p_entry-p_stop) - 1.10) > 0.01 then
    raise exception 'Scalping target ladder must follow the approved 0.75R, 1.1R and 1.5R-3R plan';
  end if;

  -- Serialize all sessions for this user so simultaneous signals cannot
  -- overrun the shared 15-position or 1% portfolio-risk limits.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_session
    from public.demo_paper_sessions
   where id = p_session_id and user_id = p_user_id
   for update;
  if not found or v_session.broker <> 'DERIV'
     or v_session.status <> 'RUNNING'
     or upper(v_session.instrument) <> upper(p_instrument)
     or v_session.config_snapshot->>'account_mode' is distinct from 'DEMO'
     or coalesce(v_session.config_snapshot->>'execution','') not in ('WEBSITE_PAPER_ONLY','WEBSITE_DEMO_AUTO_PAPER_ONLY') then
    return jsonb_build_object('ok',false,'reason','ELIGIBLE_RUNNING_DERIV_DEMO_SESSION_REQUIRED');
  end if;
  if not exists (select 1 from public.trader_profiles where user_id=p_user_id and account_mode='DEMO') then
    return jsonb_build_object('ok',false,'reason','CURRENT_ACCOUNT_MODE_NOT_DEMO');
  end if;

  -- Enforce the server-managed provider allowlist inside the atomic entry RPC,
  -- not only in the worker's symbol-discovery layer.
  if not exists (
    select 1 from public.trading_instrument_approvals a
     where a.broker='DERIV' and a.provider='DERIV'
       and upper(a.instrument)=upper(p_instrument)
       and nullif(trim(a.provider_symbol),'') is not null
       and a.status='APPROVED' and a.is_active=true
       and a.approved_at is not null and a.approved_by is not null
  ) then
    return jsonb_build_object('ok',false,'reason','SCALPING_INSTRUMENT_NOT_APPROVED');
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
  if p_candle_as_of <= coalesce(v_preference.last_candle_as_of,'epoch'::timestamptz) then
    return jsonb_build_object('ok',false,'reason','SCALPING_CANDLE_ALREADY_PROCESSED');
  end if;
  if p_risk_pct > v_preference.max_risk_per_trade_pct
     or v_session.current_balance <= 0
     or p_risk_amount > v_session.current_balance * v_preference.max_risk_per_trade_pct / 100
     or abs(p_risk_pct - (p_risk_amount / v_session.current_balance * 100)) > 0.001
     or abs(p_risk_amount - abs(p_entry-p_stop)*p_quantity*p_quote_to_usd) > 0.02 then
    raise exception 'Scalping DEMO position exceeds the approved per-trade risk budget';
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

  select count(*),
         coalesce(sum(risk_amount_usd * remaining_quantity / quantity),0)
    into v_open_count,v_open_risk
    from public.demo_paper_trades
   where user_id=p_user_id and status='OPEN';
  if v_open_count >= least(v_preference.max_open_positions,v_session.max_open_positions,15) then
    return jsonb_build_object('ok',false,'reason','SCALPING_MAX_OPEN_POSITIONS',
      'open_positions',v_open_count,'max_open_positions',least(v_preference.max_open_positions,v_session.max_open_positions,15));
  end if;

  -- Hard portfolio ceiling: all open trades combined may risk at most 1%
  -- of starting DEMO equity if every remaining stop is reached.
  -- Reserve daily realized losses first; remaining open stop-risk plus this
  -- entry must still fit inside the same 1% daily equity-loss budget.
  v_total_risk_limit := least(greatest(0,v_session.starting_balance * 0.01 - v_daily_loss),
    v_session.current_balance * v_session.max_total_open_risk_pct / 100);
  if v_open_risk + p_risk_amount > v_total_risk_limit + 0.01 then
    return jsonb_build_object('ok',false,'reason','SCALPING_TOTAL_OPEN_RISK_LIMIT',
      'open_risk_usd',v_open_risk,'requested_risk_usd',p_risk_amount,
      'portfolio_risk_limit_usd',v_total_risk_limit);
  end if;

  insert into public.demo_paper_trades(
    session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
    tp1_price,tp2_price,tp3_price,quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
    quote_source,quote_as_of,candle_as_of,trade_origin,metadata
  ) values (
    p_session_id,p_user_id,p_instrument,p_side,p_entry,p_stop,p_target,
    p_tp1,p_tp2,p_tp3,p_quantity,p_quantity,p_risk_amount,p_risk_pct,p_quote_to_usd,
    'DERIV',p_quote_as_of,p_candle_as_of,'BOT',
    jsonb_build_object('strategy','TIGER_SCHEME_QUANTUM_SCALPING','scalping_candle_as_of',p_candle_as_of)
  ) returning id into v_id;

  update public.demo_scalping_preferences
     set last_candle_as_of=p_candle_as_of,updated_at=now()
   where session_id=p_session_id and user_id=p_user_id;

  return jsonb_build_object('ok',true,'trade_id',v_id,'status','OPEN',
    'instrument',p_instrument,'side',p_side,'entry_price',p_entry,'stop_loss',p_stop,
    'take_profit',p_target,'quantity',p_quantity,'risk_amount_usd',p_risk_amount,
    'risk_pct',p_risk_pct,'opened_at',now(),'execution_mode','DEMO_PAPER_ONLY');
end;
$$;

revoke all on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) to service_role;

comment on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) is 'Service-role-only Quantum Scalping DEMO paper entry: up to 15 open positions, 0.25% per-trade maximum, 1% aggregate open-stop risk, daily loss guard, fresh Deriv quote and candle idempotency. No broker orders.';

create or replace function public.guard_scalping_single_open_position()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scalping_active boolean;
  v_open_count integer;
begin
  if new.status <> 'OPEN' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  select exists (
    select 1 from public.demo_scalping_preferences p
     where p.session_id=new.session_id and p.user_id=new.user_id
       and p.enabled=true and p.paper_execution_enabled=true
  ) or exists (
    select 1 from public.demo_paper_trades t
     where t.user_id=new.user_id and t.status='OPEN'
       and t.trade_origin='BOT'
       and t.metadata->>'strategy'='TIGER_SCHEME_QUANTUM_SCALPING'
  ) into v_scalping_active;

  if v_scalping_active then
    -- Manual DEMO trades remain available while Quantum Scalping is active.
    -- They share the same 15-position portfolio ceiling; the worker manages
    -- only bot-origin positions unless the separate manual-management consent
    -- is explicitly enabled.
    select count(*) into v_open_count from public.demo_paper_trades
     where user_id=new.user_id and status='OPEN';
    if v_open_count >= 15 then
      raise exception 'SCALPING_MAX_OPEN_POSITIONS';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists demo_paper_guard_scalping_single_open_position on public.demo_paper_trades;
create trigger demo_paper_guard_scalping_single_open_position
before insert on public.demo_paper_trades
for each row execute function public.guard_scalping_single_open_position();
revoke all on function public.guard_scalping_single_open_position() from public,anon,authenticated;
