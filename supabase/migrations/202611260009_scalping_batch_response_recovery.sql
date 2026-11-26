-- Recover a committed Quantum Scalping batch after a lost RPC response.
-- The ledger is intentionally inaccessible to API roles; this lease-fenced
-- SECURITY DEFINER function exposes only the outcome for one caller-owned session/key.
create or replace function public.get_demo_scalping_entry_batch_with_lease(
  p_lease_token uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_entry_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease public.scalping_worker_leases%rowtype;
  v_batch public.demo_scalping_entry_batches%rowtype;
begin
  if auth.role() is distinct from 'service_role'
     or p_lease_token is null
     or p_user_id is null
     or p_session_id is null
     or p_entry_key is null
     or length(trim(p_entry_key)) not between 1 and 160 then
    raise exception 'Service role, valid batch key, and worker lease required';
  end if;

  select * into v_lease
    from public.scalping_worker_leases
   where lease_key='global';
  if not found
     or v_lease.lease_token is distinct from p_lease_token
     or v_lease.lease_until is null
     or v_lease.lease_until <= clock_timestamp() then
    return jsonb_build_object('ok',false,'reason','SCALPING_WORKER_LEASE_NOT_OWNED');
  end if;

  select * into v_batch
    from public.demo_scalping_entry_batches
   where session_id=p_session_id
     and user_id=p_user_id
     and entry_key=p_entry_key;

  if not found then
    return jsonb_build_object('ok',false,'reason','SCALPING_BATCH_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok',true,
    'trade_ids',v_batch.trade_ids,
    'opened_count',v_batch.opened_count,
    'batch_key',v_batch.entry_key,
    'batch_risk_usd',v_batch.batch_risk_usd,
    'status',case when v_batch.opened_count > 0 then 'OPEN' else 'RECORDED' end,
    'recovered',true,
    'execution_mode','DEMO_PAPER_ONLY'
  );
end;
$$;

revoke all on function public.get_demo_scalping_entry_batch_with_lease(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.get_demo_scalping_entry_batch_with_lease(uuid,uuid,uuid,text)
  to service_role;

comment on function public.get_demo_scalping_entry_batch_with_lease(uuid,uuid,uuid,text)
  is 'Lease-fenced service-role recovery of a durable DEMO batch outcome after an ambiguous network response.';
