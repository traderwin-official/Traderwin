-- Contract checks for atomic Quantum Scalping batch execution.
do $$
declare
  v_inner regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_batch(uuid,uuid,jsonb,timestamptz,text)');
  v_wrapper regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_batch_with_lease(uuid,uuid,uuid,jsonb,timestamptz,text)');
  v_definition text;
begin
  if v_inner is null or v_wrapper is null then
    raise exception 'Atomic Quantum Scalping batch RPCs are missing';
  end if;
  if has_function_privilege('service_role',v_inner,'EXECUTE') then
    raise exception 'Service role must not bypass the lease-fenced batch wrapper';
  end if;
  if not has_function_privilege('service_role',v_wrapper,'EXECUTE') then
    raise exception 'Service role must be allowed to execute the lease-fenced batch wrapper';
  end if;
  select pg_get_functiondef(v_inner) into v_definition;
  if position('SCALPING_MAX_OPEN_POSITIONS' in v_definition)=0
     or position('SCALPING_TOTAL_OPEN_RISK_LIMIT' in v_definition)=0
     or position('SCALPING_DAILY_LOSS_LIMIT' in v_definition)=0
     or position('SCALPING_ENTRY_ALREADY_PROCESSED' in v_definition)=0
     or position('scalping_batch_index' in v_definition)=0
     or position('for v_entry in' in lower(v_definition))=0 then
    raise exception 'Batch RPC is missing portfolio, idempotency, or independent-position safeguards';
  end if;
  select pg_get_functiondef(v_wrapper) into v_definition;
  if position('SCALPING_WORKER_LEASE_NOT_OWNED' in v_definition)=0
     or position('open_demo_scalping_paper_trade_batch' in v_definition)=0 then
    raise exception 'Batch wrapper does not fence and forward the atomic entry operation';
  end if;
end;
$$;
