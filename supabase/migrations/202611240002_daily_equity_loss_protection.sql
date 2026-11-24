-- Daily account-equity protection: fixed 20% of the Nairobi day's opening DEMO balance.
-- DEMO paper ledger only. No REAL broker execution is enabled by this migration.

-- Ensure the append-only realization ledger exists even when this migration
-- is applied to a database that has not separately applied the earlier event migration.
create table if not exists public.demo_paper_realized_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  trade_id uuid not null references public.demo_paper_trades(id) on delete cascade,
  realized_pnl_delta_usd numeric(18,2) not null,
  realized_at timestamptz not null default now(),
  event_source text not null default 'TRADE_REALIZED_PNL_UPDATE'
    check (event_source='TRADE_REALIZED_PNL_UPDATE')
);
create index if not exists demo_paper_realized_events_user_day_idx
  on public.demo_paper_realized_events(user_id,realized_at desc);
alter table public.demo_paper_realized_events enable row level security;
revoke all on public.demo_paper_realized_events from public,anon,authenticated;
grant all on public.demo_paper_realized_events to service_role;

create table if not exists public.demo_daily_risk_baselines (
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_day date not null,
  day_start timestamptz not null,
  opening_balance_usd numeric(18,2) not null check (opening_balance_usd >= 0),
  loss_limit_pct numeric(5,2) not null default 20 check (loss_limit_pct = 20),
  loss_threshold_usd numeric(18,2) not null check (loss_threshold_usd >= 0),
  created_at timestamptz not null default now(),
  primary key(user_id,trading_day)
);
alter table public.demo_daily_risk_baselines enable row level security;
revoke all on public.demo_daily_risk_baselines from public,anon,authenticated;
grant all on public.demo_daily_risk_baselines to service_role;

create or replace function public.get_demo_daily_opening_balance(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_day_start timestamptz;
  v_day date;
  v_current_balance numeric(18,2);
  v_today_realized numeric(18,2);
  v_opening numeric(18,2);
  v_row public.demo_daily_risk_baselines%rowtype;
begin
  if auth.role() is distinct from 'service_role' or p_user_id is null then
    raise exception 'Service role required';
  end if;
  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
  v_day := (now() at time zone 'Africa/Nairobi')::date;
  select greatest(0,round(10000 + coalesce(sum(realized_pnl_usd),0),2))
    into v_current_balance
    from public.demo_paper_trades where user_id=p_user_id;
  select coalesce(sum(realized_pnl_delta_usd),0)
    into v_today_realized
    from public.demo_paper_realized_events
   where user_id=p_user_id and realized_at>=v_day_start;
  v_opening := greatest(0,round(coalesce(v_current_balance,10000)-coalesce(v_today_realized,0),2));
  insert into public.demo_daily_risk_baselines(user_id,trading_day,day_start,opening_balance_usd,loss_limit_pct,loss_threshold_usd)
  values(p_user_id,v_day,v_day_start,v_opening,20,round(v_opening*0.20,2))
  on conflict(user_id,trading_day) do nothing;
  select * into v_row from public.demo_daily_risk_baselines
   where user_id=p_user_id and trading_day=v_day;
  return jsonb_build_object('trading_day',v_row.trading_day,'day_start',v_row.day_start,
    'opening_balance_usd',v_row.opening_balance_usd,'loss_limit_pct',20,
    'loss_threshold_usd',v_row.loss_threshold_usd);
end $$;

create or replace function public.evaluate_demo_daily_loss_guard(
  p_user_id uuid,
  p_floating_pnl_usd numeric
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_baseline jsonb;
  v_opening numeric(18,2);
  v_threshold numeric(18,2);
  v_realized numeric(18,2);
  v_floating numeric(18,2);
  v_equity numeric(18,2);
  v_triggered boolean;
  v_day_start timestamptz;
begin
  if auth.role() is distinct from 'service_role' or p_user_id is null
     or p_floating_pnl_usd is null or p_floating_pnl_usd::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Service role required and valid floating P/L required';
  end if;
  v_baseline := public.get_demo_daily_opening_balance(p_user_id);
  v_opening := (v_baseline->>'opening_balance_usd')::numeric;
  v_threshold := (v_baseline->>'loss_threshold_usd')::numeric;
  v_day_start := (v_baseline->>'day_start')::timestamptz;
  select coalesce(sum(realized_pnl_delta_usd),0) into v_realized
    from public.demo_paper_realized_events
   where user_id=p_user_id and realized_at>=v_day_start;
  v_floating := round(p_floating_pnl_usd,2);
  v_equity := greatest(0,round(v_opening+v_realized+v_floating,2));
  v_triggered := v_equity <= greatest(0,v_opening-v_threshold);

  -- Keep legacy session-level checks aligned to the account-wide daily baseline.
  update public.demo_paper_sessions
     set starting_balance=greatest(0.01,v_opening),max_daily_loss_pct=20,
         status=case when v_triggered and status in ('RUNNING','PAUSED') then 'RISK_LOCKED' else status end,
         risk_locked_at=case when v_triggered then coalesce(risk_locked_at,now()) else risk_locked_at end,
         updated_at=now()
   where user_id=p_user_id and status in ('RUNNING','PAUSED','RISK_LOCKED');

  return jsonb_build_object('ok',true,'trading_day',v_baseline->>'trading_day',
    'opening_balance_usd',v_opening,'realized_pnl_usd',round(v_realized,2),
    'floating_pnl_usd',v_floating,'current_equity_usd',v_equity,
    'loss_limit_pct',20,'loss_amount_usd',v_threshold,
    'trigger_equity_usd',greatest(0,v_opening-v_threshold),'triggered',v_triggered);
end $$;

-- The legacy configurable limit is superseded by the fixed account-wide 20% rule.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
   where conrelid='public.demo_paper_sessions'::regclass and contype='c'
     and pg_get_constraintdef(oid) ilike '%max_daily_loss_pct%'
  loop execute format('alter table public.demo_paper_sessions drop constraint %I',c.conname); end loop;
end $$;
alter table public.demo_paper_sessions
  add constraint demo_paper_sessions_daily_loss_fixed_20
  check (max_daily_loss_pct=20);
update public.demo_paper_sessions set max_daily_loss_pct=20;

create or replace function public.enforce_demo_daily_loss_configuration()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb;
begin
  v:=public.get_demo_daily_opening_balance(new.user_id);
  new.starting_balance:=greatest(0.01,(v->>'opening_balance_usd')::numeric);
  new.max_daily_loss_pct:=20;
  return new;
end $$;
drop trigger if exists demo_paper_force_daily_loss_configuration on public.demo_paper_sessions;
create trigger demo_paper_force_daily_loss_configuration
before insert or update of max_daily_loss_pct,starting_balance on public.demo_paper_sessions
for each row execute function public.enforce_demo_daily_loss_configuration();

-- Realized P/L still creates append-only daily events. The old trigger's
-- configurable/session-starting-balance lock is replaced by the 20% account rule.
create or replace function public.record_demo_paper_realized_event()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_delta numeric(18,2);
begin
  if new.realized_pnl_usd is not distinct from old.realized_pnl_usd then return new; end if;
  v_delta:=round(coalesce(new.realized_pnl_usd,0)-coalesce(old.realized_pnl_usd,0),2);
  if v_delta=0 then return new; end if;
  insert into public.demo_paper_realized_events(user_id,session_id,trade_id,realized_pnl_delta_usd)
  values(new.user_id,new.session_id,new.id,v_delta);
  perform public.evaluate_demo_daily_loss_guard(new.user_id,0);
  return new;
end $$;

create or replace function public.guard_new_demo_paper_session_daily_loss()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; v_opening numeric(18,2); v_threshold numeric(18,2); v_realized numeric(18,2); v_day_start timestamptz;
begin
  v:=public.get_demo_daily_opening_balance(new.user_id);
  v_opening:=(v->>'opening_balance_usd')::numeric;
  v_threshold:=(v->>'loss_threshold_usd')::numeric;
  v_day_start:=(v->>'day_start')::timestamptz;
  select coalesce(sum(realized_pnl_delta_usd),0) into v_realized
    from public.demo_paper_realized_events where user_id=new.user_id and realized_at>=v_day_start;
  new.starting_balance:=greatest(0.01,v_opening);
  new.max_daily_loss_pct:=20;
  if v_opening+v_realized <= greatest(0,v_opening-v_threshold) then
    new.status:='RISK_LOCKED'; new.risk_locked_at:=coalesce(new.risk_locked_at,now());
  end if;
  return new;
end $$;

drop trigger if exists demo_paper_record_realized_event on public.demo_paper_trades;
create trigger demo_paper_record_realized_event
after update of realized_pnl_usd on public.demo_paper_trades
for each row execute function public.record_demo_paper_realized_event();

create or replace function public.close_demo_daily_loss_trade(
  p_user_id uuid,p_trade_id uuid,p_exit_price numeric,p_quote_to_usd numeric,
  p_quote_source text,p_quote_as_of timestamptz,p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_trade public.demo_paper_trades%rowtype;
  v_session public.demo_paper_sessions%rowtype;
  v_permission public.portfolio_trade_permissions%rowtype;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_user_id is null or p_trade_id is null or p_exit_price is null or p_exit_price<=0
     or p_quote_to_usd is null or p_quote_to_usd<=0 or p_quote_source is distinct from 'DERIV'
     or p_quote_as_of is null or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
     or p_idempotency_key is null or nullif(trim(p_idempotency_key),'') is null
     or length(p_idempotency_key)>200 then
    raise exception 'Invalid or stale daily-loss close request';
  end if;
  select * into v_trade from public.demo_paper_trades
   where id=p_trade_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','TRADE_NOT_FOUND'); end if;
  if v_trade.status='CLOSED' then
    return jsonb_build_object('ok',v_trade.metadata->>'daily_loss_close_key'=p_idempotency_key,
      'already_closed',true,'trade_id',v_trade.id,'reason','DAILY_LOSS_LIMIT');
  end if;
  if v_trade.status<>'OPEN' then return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN'); end if;
  select * into v_session from public.demo_paper_sessions
   where id=v_trade.session_id and user_id=p_user_id for update;
  if not found or v_session.broker<>'DERIV' then return jsonb_build_object('ok',false,'reason','DEMO_ACCOUNT_NOT_FOUND'); end if;
  select * into v_permission from public.portfolio_trade_permissions
   where user_id=p_user_id and account_mode='DEMO' and broker='DERIV'
     and broker_account_ref=v_session.broker_account_ref for update;
  if v_trade.trade_origin='MANUAL' then
    if not found or v_permission.manual_trade_management is not true
       or v_permission.close_manual_trades is not true
       or v_permission.close_managed_positions is not true then
      return jsonb_build_object('ok',false,'reason','MANUAL_CLOSE_PERMISSION_NOT_GRANTED');
    end if;
  elsif v_trade.trade_origin='BOT' then
    if found and (v_permission.bot_trade_management is not true
       or v_permission.close_managed_positions is not true) then
      return jsonb_build_object('ok',false,'reason','BOT_CLOSE_PERMISSION_NOT_GRANTED');
    end if;
  else return jsonb_build_object('ok',false,'reason','UNSUPPORTED_TRADE_ORIGIN'); end if;
  update public.demo_paper_trades set metadata=coalesce(metadata,'{}'::jsonb)||
    jsonb_build_object('daily_loss_close_key',p_idempotency_key,'daily_loss_close_reason','DAILY_LOSS_LIMIT')
   where id=v_trade.id;
  v_result:=public.close_demo_paper_trade(p_user_id,p_trade_id,p_exit_price,p_quote_to_usd,
    p_quote_source,p_quote_as_of,'MANUAL_CLOSE');
  if coalesce((v_result->>'ok')::boolean,false) is not true then return v_result; end if;
  return v_result||jsonb_build_object('reason','DAILY_LOSS_LIMIT','idempotency_key',p_idempotency_key);
end $$;

drop trigger if exists demo_paper_guard_new_session_daily_loss on public.demo_paper_sessions;
create trigger demo_paper_guard_new_session_daily_loss
before insert on public.demo_paper_sessions
for each row execute function public.guard_new_demo_paper_session_daily_loss();

revoke all on function public.get_demo_daily_opening_balance(uuid),
  public.evaluate_demo_daily_loss_guard(uuid,numeric),
  public.enforce_demo_daily_loss_configuration(),
  public.close_demo_daily_loss_trade(uuid,uuid,numeric,numeric,text,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.get_demo_daily_opening_balance(uuid),
  public.evaluate_demo_daily_loss_guard(uuid,numeric),
  public.close_demo_daily_loss_trade(uuid,uuid,numeric,numeric,text,timestamptz,text)
  to service_role;

comment on table public.demo_daily_risk_baselines is
'Immutable per-user Nairobi-day DEMO account opening balance snapshots; daily protection triggers at 20% equity drawdown from this baseline.';
