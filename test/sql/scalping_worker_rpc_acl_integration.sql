\set ON_ERROR_STOP on

-- Every overload of a worker-facing RPC must be safe. Do not assume that a
-- function name has only one signature: older compatibility overloads may
-- coexist with the lease-fenced worker entry point.
do $$
declare
  v_name text;
  v_proc regprocedure;
  v_config text[];
  v_count integer;
  v_service_role_count integer;
begin
  foreach v_name in array array[
    'open_demo_scalping_paper_trade_with_lease',
    'open_demo_scalping_paper_trade_batch_with_lease',
    'get_demo_scalping_entry_batch_with_lease',
    'close_demo_scalping_paper_trade_with_lease',
    'mark_demo_scalping_paper_trade_with_lease'
  ] loop
    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=v_name;

    if v_count = 0 then
      raise exception 'Required worker RPC is missing: %', v_name;
    end if;

    v_service_role_count := 0;

    for v_proc, v_config in
      select p.oid::regprocedure, p.proconfig
        from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=v_name
    loop
      if not (select prosecdef from pg_proc where oid=v_proc) then
        raise exception 'Worker RPC overload % must be SECURITY DEFINER', v_proc;
      end if;

      if not coalesce(v_config, '{}'::text[]) @> array['search_path=public, pg_temp']::text[] then
        raise exception 'Worker RPC overload % must pin search_path to public, pg_temp; found %', v_proc, v_config;
      end if;

      if has_function_privilege('service_role', v_proc, 'EXECUTE') then
        v_service_role_count := v_service_role_count + 1;
      end if;

      if has_function_privilege('anon', v_proc, 'EXECUTE')
         or has_function_privilege('authenticated', v_proc, 'EXECUTE')
         or exists (
           select 1
             from pg_proc p,
                  lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
            where p.oid=v_proc and a.grantee=0 and a.privilege_type='EXECUTE'
         ) then
        raise exception 'Worker RPC overload % must not be executable by PUBLIC, anon, or authenticated', v_proc;
      end if;
    end loop;

    if v_service_role_count <> 1 then
      raise exception 'Worker RPC % must expose exactly one service_role-executable overload; found %', v_name, v_service_role_count;
    end if;
  end loop;

  -- This legacy staged-exit RPC was intentionally retired when full-position
  -- exits replaced staged scalping exits. Keep it present but inaccessible.
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname='manage_demo_scalping_paper_exit_with_lease'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'Retired staged-exit RPC must not be executable by service_role';
  end if;
end
$$;
