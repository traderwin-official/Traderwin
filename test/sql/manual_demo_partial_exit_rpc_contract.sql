-- Verify the staged MANUAL DEMO RPCs exist and are service-role-only.
do $$
declare
  v_open regprocedure := to_regprocedure('public.open_demo_manual_partial_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text,timestamptz)');
  v_exit regprocedure := to_regprocedure('public.manage_demo_manual_partial_exit(uuid,uuid,text,numeric,numeric,text,timestamptz)');
begin
  if v_open is null then raise exception 'open_demo_manual_partial_trade RPC is missing'; end if;
  if v_exit is null then raise exception 'manage_demo_manual_partial_exit RPC is missing'; end if;
  if has_function_privilege('anon',v_open,'EXECUTE') or has_function_privilege('authenticated',v_open,'EXECUTE') then
    raise exception 'Manual partial trade opening RPC must not be executable by anon/authenticated';
  end if;
  if has_function_privilege('anon',v_exit,'EXECUTE') or has_function_privilege('authenticated',v_exit,'EXECUTE') then
    raise exception 'Manual partial exit RPC must not be executable by anon/authenticated';
  end if;
  if not has_function_privilege('service_role',v_open,'EXECUTE') or not has_function_privilege('service_role',v_exit,'EXECUTE') then
    raise exception 'Service role must retain execute permission on manual DEMO RPCs';
  end if;
end;
$$;
