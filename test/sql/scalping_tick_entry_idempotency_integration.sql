-- Contract checks for tick-level Quantum Scalping entry idempotency.
do $$
declare
  v_inner regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,timestamptz,timestamptz,text)');
  v_wrapper regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,timestamptz,timestamptz,text)');
  v_old_wrapper regprocedure := to_regprocedure('public.open_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,timestamptz)');
  v_definition text;
begin
  if v_inner is null or v_wrapper is null or v_old_wrapper is null then
    raise exception 'Expected current and legacy scalping RPC signatures to exist';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='demo_scalping_preferences' and column_name='last_entry_as_of')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='demo_scalping_preferences' and column_name='last_entry_key') then
    raise exception 'Tick-level entry idempotency columns are missing';
  end if;
  select pg_get_functiondef(v_inner) into v_definition;
  if position('SCALPING_ENTRY_ALREADY_PROCESSED' in v_definition)=0
     or position('SCALPING_ENTRY_RATE_LIMIT' in v_definition)=0
     or position('SCALPING_CANDLE_ALREADY_PROCESSED' in v_definition)>0
     or position('scalping_entry_key' in v_definition)=0 then
    raise exception 'Inner scalping RPC does not implement tick-level deduplication while preserving candle metadata';
  end if;
  select pg_get_functiondef(v_wrapper) into v_definition;
  if position('p_entry_as_of' in v_definition)=0
     or position('p_entry_key' in v_definition)=0 then
    raise exception 'Lease wrapper does not forward tick-level idempotency values';
  end if;
  if not has_function_privilege('service_role',v_wrapper,'EXECUTE') then
    raise exception 'Service role must be able to execute only the new lease-fenced entry wrapper';
  end if;
  if has_function_privilege('service_role',v_old_wrapper,'EXECUTE') then
    raise exception 'Legacy lease wrapper must not remain executable by service role';
  end if;
end;
$$;
