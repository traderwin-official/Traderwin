-- Enforce the agreed DEMO risk policy at the database boundary.
-- Existing positions remain manageable; new positions and reservations are capped.
begin;

alter table public.demo_paper_sessions
  alter column risk_per_trade_pct set default 0.25,
  alter column max_daily_loss_pct set default 1.00,
  alter column max_total_open_risk_pct set default 1.00;

alter table public.demo_paper_sessions
  add constraint demo_paper_sessions_risk_per_trade_platform_cap
    check (risk_per_trade_pct > 0 and risk_per_trade_pct <= 0.25) not valid,
  add constraint demo_paper_sessions_daily_loss_platform_cap
    check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 1.00) not valid,
  add constraint demo_paper_sessions_total_open_risk_platform_cap
    check (max_total_open_risk_pct > 0 and max_total_open_risk_pct <= 1.00) not valid;

-- Tighten existing session settings, without altering historical trade records.
update public.demo_paper_sessions
   set risk_per_trade_pct = least(risk_per_trade_pct, 0.25),
       max_daily_loss_pct = least(max_daily_loss_pct, 1.00),
       max_total_open_risk_pct = least(max_total_open_risk_pct, 1.00),
       updated_at = now()
 where risk_per_trade_pct > 0.25
    or max_daily_loss_pct > 1.00
    or max_total_open_risk_pct > 1.00;

create or replace function public.guard_demo_paper_trade_risk_budget()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_paper_sessions%rowtype;
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
  v_open_risk numeric(18,2);
  v_pending_risk numeric(18,2);
  v_batch_id uuid;
  v_budget numeric(18,2);
begin
  if new.status <> 'OPEN' then
    return new;
  end if;

  select * into v_session
    from public.demo_paper_sessions
   where id = new.session_id and user_id = new.user_id
   for update;
  if not found then
    raise exception 'DEMO session not found for risk-budget check';
  end if;

  if v_session.risk_per_trade_pct > 0.25
     or v_session.max_daily_loss_pct > 1.00
     or v_session.max_total_open_risk_pct > 1.00
     or new.risk_pct > 0.25
     or new.risk_amount_usd > v_session.current_balance * 0.25 / 100 + 0.01 then
    raise exception 'DEMO trade exceeds the platform per-trade risk cap';
  end if;

  v_day_start := date_trunc('day', now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0, -coalesce(sum(least(realized_pnl_delta_usd, 0)), 0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  select coalesce(sum(
    risk_amount_usd * remaining_quantity / nullif(quantity, 0)
  ), 0)
    into v_open_risk
    from public.demo_paper_trades
   where user_id = new.user_id and status = 'OPEN';

  if coalesce(new.metadata->>'manual_entry_batch_id', '') ~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_batch_id := (new.metadata->>'manual_entry_batch_id')::uuid;
  end if;

  select coalesce(sum(total_risk_usd), 0)
    into v_pending_risk
    from public.demo_manual_entry_batches
   where user_id = new.user_id
     and session_id = new.session_id
     and status = 'PENDING'
     and expires_at > now()
     and (v_batch_id is null or id <> v_batch_id);

  v_budget := v_session.starting_balance
    * least(v_session.max_total_open_risk_pct, 1.00) / 100;

  if v_daily_loss + v_open_risk + v_pending_risk + new.risk_amount_usd
       > v_budget + 0.01 then
    raise exception 'DEMO combined daily loss, open risk and pending reservations exceed the 1 percent equity budget';
  end if;

  return new;
end;
$$;

drop trigger if exists demo_paper_guard_combined_risk_budget
  on public.demo_paper_trades;
create trigger demo_paper_guard_combined_risk_budget
before insert on public.demo_paper_trades
for each row execute function public.guard_demo_paper_trade_risk_budget();

revoke all on function public.guard_demo_paper_trade_risk_budget()
  from public, anon, authenticated;

create or replace function public.guard_demo_manual_batch_risk_budget()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.demo_paper_sessions%rowtype;
  v_day_start timestamptz;
  v_daily_loss numeric(18,2);
  v_open_risk numeric(18,2);
  v_pending_risk numeric(18,2);
  v_budget numeric(18,2);
begin
  if new.status <> 'PENDING' then
    return new;
  end if;

  select * into v_session
    from public.demo_paper_sessions
   where id = new.session_id and user_id = new.user_id
   for update;
  if not found then
    raise exception 'DEMO session not found for pending-risk reservation';
  end if;

  if v_session.risk_per_trade_pct > 0.25
     or v_session.max_daily_loss_pct > 1.00
     or v_session.max_total_open_risk_pct > 1.00
     or new.total_risk_pct > v_session.risk_per_trade_pct
     or new.total_risk_pct > 1.00 then
    raise exception 'Pending DEMO batch exceeds the platform risk cap';
  end if;

  v_day_start := date_trunc('day', now() at time zone 'Africa/Nairobi')
    at time zone 'Africa/Nairobi';

  select greatest(0, -coalesce(sum(least(realized_pnl_delta_usd, 0)), 0))
    into v_daily_loss
    from public.demo_paper_realized_events
   where user_id = new.user_id and realized_at >= v_day_start;

  select coalesce(sum(
    risk_amount_usd * remaining_quantity / nullif(quantity, 0)
  ), 0)
    into v_open_risk
    from public.demo_paper_trades
   where user_id = new.user_id and status = 'OPEN';

  select coalesce(sum(total_risk_usd), 0)
    into v_pending_risk
    from public.demo_manual_entry_batches
   where user_id = new.user_id
     and session_id = new.session_id
     and status = 'PENDING'
     and expires_at > now();

  v_budget := v_session.starting_balance
    * least(v_session.max_total_open_risk_pct, 1.00) / 100;

  if v_daily_loss + v_open_risk + v_pending_risk + new.total_risk_usd
       > v_budget + 0.01 then
    raise exception 'DEMO combined daily loss, open risk and pending reservations exceed the 1 percent equity budget';
  end if;

  return new;
end;
$$;

drop trigger if exists demo_manual_batch_guard_combined_risk_budget
  on public.demo_manual_entry_batches;
create trigger demo_manual_batch_guard_combined_risk_budget
before insert on public.demo_manual_entry_batches
for each row execute function public.guard_demo_manual_batch_risk_budget();

revoke all on function public.guard_demo_manual_batch_risk_budget()
  from public, anon, authenticated;

comment on function public.guard_demo_paper_trade_risk_budget() is
  'Enforces per-trade risk <= 0.25% and combined realized daily losses, open stop-risk and pending reservations <= 1% of starting DEMO equity. Existing positions remain manageable.';
comment on function public.guard_demo_manual_batch_risk_budget() is
  'Reserves pending manual DEMO entry risk inside the same combined 1% account equity budget.';

commit;
