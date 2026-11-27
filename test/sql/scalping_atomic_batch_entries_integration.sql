-- Contract checks for atomic Quantum Scalping batch execution.
do $$
declare
  v_inner regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_batch(uuid,uuid,jsonb,timestamptz,text)');
  v_wrapper regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_batch_with_lease(uuid,uuid,uuid,jsonb,timestamptz,text)');
  v_recovery regprocedure := to_regprocedure('public.get_demo_scalping_entry_batch_with_lease(uuid,uuid,uuid,text)');
  v_definition text;
begin
  if v_inner is null or v_wrapper is null or v_recovery is null then
    raise exception 'Atomic Quantum Scalping batch and recovery RPCs are missing';
  end if;
  if to_regclass('public.demo_scalping_entry_batches') is null then
    raise exception 'Durable Quantum Scalping batch idempotency ledger is missing';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname='public' and tablename='demo_scalping_entry_batches'
       and indexdef ilike '%unique%session_id%entry_key%'
  ) then
    raise exception 'Batch idempotency ledger must enforce unique session and entry key';
  end if;
  if has_table_privilege('service_role','public.demo_scalping_entry_batches','SELECT')
     or has_table_privilege('authenticated','public.demo_scalping_entry_batches','SELECT') then
    raise exception 'Batch idempotency ledger must not be directly readable by API roles';
  end if;
  if has_function_privilege('service_role',v_inner,'EXECUTE') then
    raise exception 'Service role must not bypass the lease-fenced batch wrapper';
  end if;
  if not has_function_privilege('service_role',v_wrapper,'EXECUTE') then
    raise exception 'Service role must be allowed to execute the lease-fenced batch wrapper';
  end if;
  if has_function_privilege('authenticated',v_recovery,'EXECUTE')
     or not has_function_privilege('service_role',v_recovery,'EXECUTE') then
    raise exception 'Batch recovery must be service-role-only';
  end if;
  select pg_get_functiondef(v_recovery) into v_definition;
  if position('SCALPING_WORKER_LEASE_NOT_OWNED' in v_definition)=0
     or position('demo_scalping_entry_batches' in v_definition)=0
     or position('SCALPING_BATCH_NOT_FOUND' in v_definition)=0 then
    raise exception 'Batch recovery must be lease-fenced and read the durable batch ledger';
  end if;
  select pg_get_functiondef(v_inner) into v_definition;
  if position('SCALPING_MAX_OPEN_POSITIONS' in v_definition)=0
     or position('SCALPING_TOTAL_OPEN_RISK_LIMIT' in v_definition)=0
     or position('SCALPING_DAILY_LOSS_LIMIT' in v_definition)=0
     or position('SCALPING_ENTRY_ALREADY_PROCESSED' in v_definition)=0
     or position('scalping_batch_index' in v_definition)=0
     or position('demo_paper_emergency_controls' in v_definition)=0
     or position('entries_blocked' in v_definition)=0
     or position('bot_emergency_controls' in v_definition)=0
     or position('kill_switch_active' in v_definition)=0
     or position('KILL_SWITCH_ACTIVE' in v_definition)=0
     or position('for v_entry in' in lower(v_definition))=0
     or position('demo_scalping_entry_batches' in v_definition)=0
     or position('on conflict' in lower(v_definition))=0 then
    raise exception 'Batch RPC is missing portfolio, durable idempotency, or independent-position safeguards';
  end if;
  select pg_get_functiondef(v_wrapper) into v_definition;
  if position('SCALPING_WORKER_LEASE_NOT_OWNED' in v_definition)=0
     or position('open_demo_scalping_paper_trade_batch' in v_definition)=0 then
    raise exception 'Batch wrapper does not fence and forward the atomic entry operation';
  end if;
end;
$$;
