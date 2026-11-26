-- Fence every continuous scalping paper entry against the current singleton worker lease.
-- The row lock is held until the nested entry RPC commits, so another worker cannot
-- take over the lease between validation and insertion.
create or replace function public.open_demo_scalping_paper_trade_with_lease(
  p_lease_token uuid,
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
  v_lease public.scalping_worker_leases%rowtype;
begin
  if auth.role() is distinct from 'service_role' or p_lease_token is null then
    raise exception 'Service role and current scalping worker lease required';
  end if;

  select * into v_lease
    from public.scalping_worker_leases
   where lease_key = 'global'
   for update;

  if not found or v_lease.lease_token is distinct from p_lease_token
     or v_lease.lease_until is null or v_lease.lease_until <= clock_timestamp() then
    return jsonb_build_object('ok',false,'reason','SCALPING_WORKER_LEASE_NOT_OWNED');
  end if;

  return public.open_demo_scalping_paper_trade(
    p_user_id,p_session_id,p_instrument,p_side,p_entry,p_stop,p_target,
    p_tp1,p_tp2,p_tp3,p_quantity,p_risk_amount,p_risk_pct,p_quote_to_usd,
    p_quote_as_of,p_candle_as_of
  );
end;
$$;

revoke all on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) to service_role;

comment on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) is 'Lease-fenced service-only wrapper for Quantum Scalping DEMO paper entries; locks and validates the singleton worker lease for the full entry transaction.';
