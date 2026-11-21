-- Record each realized P&L change in the isolated v2/v3 DEMO paper ledger.
-- This prevents a partial exit on one day from being incorrectly carried into
-- a later day's cumulative trade P&L when the remaining quantity is closed.
-- Additive only: no production broker tables or REAL accounts are changed.

create table if not exists public.demo_paper_realized_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.demo_paper_sessions(id) on delete cascade,
  trade_id uuid not null references public.demo_paper_trades(id) on delete cascade,
  realized_pnl_delta_usd numeric(18,2) not null,
  realized_at timestamptz not null default now(),
  event_source text not null default 'TRADE_REALIZED_PNL_UPDATE'
    check (event_source = 'TRADE_REALIZED_PNL_UPDATE')
);

create index if not exists demo_paper_realized_events_user_day_idx
  on public.demo_paper_realized_events(user_id, realized_at desc);

alter table public.demo_paper_realized_events enable row level security;
revoke all on public.demo_paper_realized_events from public, anon, authenticated;
grant all on public.demo_paper_realized_events to service_role;

create or replace function public.record_demo_paper_realized_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delta numeric(18,2);
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
begin
  if new.realized_pnl_usd is not distinct from old.realized_pnl_usd then
    return new;
  end if;

  v_delta := round(coalesce(new.realized_pnl_usd,0) - coalesce(old.realized_pnl_usd,0),2);
  if v_delta = 0 then
    return new;
  end if;

  insert into public.demo_paper_realized_events(
    user_id,session_id,trade_id,realized_pnl_delta_usd
  ) values (new.user_id,new.session_id,new.id,v_delta);

  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  -- Lock every active virtual session for this user once the daily loss
  -- threshold is reached. This happens in the same transaction as the P&L
  -- update, so another entry cannot slip through between realization and lock.
  update public.demo_paper_sessions
     set status = 'RISK_LOCKED',
         risk_locked_at = coalesce(risk_locked_at,now()),
         updated_at = now()
   where user_id = new.user_id
     and status in ('RUNNING','PAUSED')
     and v_daily_loss >= starting_balance * max_daily_loss_pct / 100;

  return new;
end;
$$;

drop trigger if exists demo_paper_record_realized_event
  on public.demo_paper_trades;
create trigger demo_paper_record_realized_event
after update of realized_pnl_usd on public.demo_paper_trades
for each row
execute function public.record_demo_paper_realized_event();

create or replace function public.guard_new_demo_paper_session_daily_loss()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
begin
  v_day_start := date_trunc('day',now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0,-coalesce(sum(least(realized_pnl_delta_usd,0)),0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  if v_daily_loss >= new.starting_balance * new.max_daily_loss_pct / 100 then
    new.status := 'RISK_LOCKED';
    new.risk_locked_at := coalesce(new.risk_locked_at,now());
  end if;
  return new;
end;
$$;

drop trigger if exists demo_paper_guard_new_session_daily_loss
  on public.demo_paper_sessions;
create trigger demo_paper_guard_new_session_daily_loss
before insert on public.demo_paper_sessions
for each row
execute function public.guard_new_demo_paper_session_daily_loss();

revoke all on function public.record_demo_paper_realized_event()
  from public, anon, authenticated;
revoke all on function public.guard_new_demo_paper_session_daily_loss()
  from public, anon, authenticated;

comment on table public.demo_paper_realized_events is
'Append-only audit of each change to cumulative realized P&L in the isolated DEMO paper ledger. Negative realization deltas count toward the Nairobi trading-day loss lock.';
