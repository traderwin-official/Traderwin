-- Contract tests for the isolated Quantum Scalping full-position exit RPC.
-- Runs after the migration stack in disposable PostgreSQL; it does not touch production.
do $$
declare
  v_inner regprocedure := to_regprocedure(
    'public.close_demo_scalping_paper_trade(uuid,uuid,text,numeric,numeric,text,timestamptz)'
  );
  v_wrapper regprocedure := to_regprocedure(
    'public.close_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz)'
  );
  v_inner_def text;
  v_wrapper_def text;
begin
  if v_inner is null or v_wrapper is null then
    raise exception 'Scalping full-position close RPCs are missing';
  end if;

  if has_function_privilege('service_role',v_inner,'EXECUTE')
     or has_function_privilege('authenticated',v_inner,'EXECUTE')
     or has_function_privilege('anon',v_inner,'EXECUTE') then
    raise exception 'Inner scalping close RPC must not be directly executable by API roles';
  end if;
  if not has_function_privilege('service_role',v_wrapper,'EXECUTE')
     or has_function_privilege('authenticated',v_wrapper,'EXECUTE')
     or has_function_privilege('anon',v_wrapper,'EXECUTE') then
    raise exception 'Only service_role may execute the lease-fenced scalping close RPC';
  end if;

  select pg_get_functiondef(v_inner) into v_inner_def;
  if position('service_role' in v_inner_def)=0
     or position('TAKE_PROFIT' in v_inner_def)=0
     or position('STOP_LOSS' in v_inner_def)=0
     or position('DERIV' in v_inner_def)=0
     or position('remaining_quantity' in v_inner_def)=0
     or position('remaining_quantity=0' in replace(v_inner_def,' ',''))=0
     or position('status=''CLOSED''' in v_inner_def)=0
     or position('NOT_A_SCALPING_BOT_POSITION' in v_inner_def)=0
     or position('STOP_LOSS_NOT_REACHED' in v_inner_def)=0
     or position('TAKE_PROFIT_NOT_REACHED' in v_inner_def)=0
     or position('TRADE_NOT_OPEN' in v_inner_def)=0 then
    raise exception 'Scalping close RPC lacks full-close, strategy isolation, quote or target guards';
  end if;

  -- This strategy's exit contract must not contain staged TP1/TP2/TP3 execution.
  if position('TP1' in v_inner_def)>0
     or position('TP2' in v_inner_def)>0
     or position('p_stage' in v_inner_def)>0 then
    raise exception 'Scalping close RPC must close the full remaining position, not stage partial exits';
  end if;

  select pg_get_functiondef(v_wrapper) into v_wrapper_def;
  if position('SCALPING_WORKER_LEASE_NOT_OWNED' in v_wrapper_def)=0
     or position('lease_until' in v_wrapper_def)=0
     or position('close_demo_scalping_paper_trade' in v_wrapper_def)=0 then
    raise exception 'Scalping close wrapper must enforce the live worker lease';
  end if;

  -- The existing manual partial-exit RPC remains present and separately callable.
  if to_regprocedure('public.manage_demo_manual_partial_exit(uuid,uuid,text,numeric,numeric,text,timestamptz)') is null then
    raise exception 'Existing general DEMO partial-exit RPC must remain available';
  end if;
end;
$$;
