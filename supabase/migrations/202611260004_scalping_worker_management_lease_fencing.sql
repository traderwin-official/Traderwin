-- Fence the continuous worker's scalping exit and mark writes as well as entries.
-- This prevents a displaced process from racing the new lease owner on open positions.
create or replace function public.mark_demo_scalping_paper_trade_with_lease(
  p_lease_token uuid,
  p_user_id uuid,
  p_trade_id uuid,
  p_price numeric,
  p_quote_as_of timestamptz
) returns boolean
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
    return false;
  end if;
  if not exists (
    select 1 from public.demo_paper_trades
     where id=p_trade_id and user_id=p_user_id and status='OPEN'
       and trade_origin='BOT'
       and metadata->>'strategy'='TIGER_SCHEME_QUANTUM_SCALPING'
  ) then
    return false;
  end if;
  return public.mark_demo_paper_trade(p_user_id,p_trade_id,p_price,p_quote_as_of);
end;
$$;

create or replace function public.manage_demo_scalping_paper_exit_with_lease(
  p_lease_token uuid,
  p_user_id uuid,
  p_trade_id uuid,
  p_stage text,
  p_exit_price numeric,
  p_quote_to_usd numeric,
  p_quote_source text,
  p_quote_as_of timestamptz
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
  if not exists (
    select 1 from public.demo_paper_trades
     where id=p_trade_id and user_id=p_user_id and status='OPEN'
       and trade_origin='BOT'
       and metadata->>'strategy'='TIGER_SCHEME_QUANTUM_SCALPING'
  ) then
    return jsonb_build_object('ok',false,'reason','SCALPING_POSITION_NOT_FOUND');
  end if;
  return public.manage_demo_paper_exit(
    p_user_id,p_trade_id,p_stage,p_exit_price,p_quote_to_usd,p_quote_source,p_quote_as_of
  );
end;
$$;

revoke all on function public.mark_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,numeric,timestamptz)
  from public,anon,authenticated;
revoke all on function public.manage_demo_scalping_paper_exit_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.mark_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,numeric,timestamptz)
  to service_role;
grant execute on function public.manage_demo_scalping_paper_exit_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz)
  to service_role;
