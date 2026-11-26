\set ON_ERROR_STOP on

-- Verify the worker-facing DEMO scalping RPCs are executable only by the
-- server-side service role and pin their SECURITY DEFINER search_path.
do $$
declare
  v_name text;
  v_proc regprocedure;
  v_count integer;
  v_config text[];
begin
  foreach v_name in array array[
    'open_demo_scalping_paper_trade_with_lease',
    'open_demo_scalping_paper_trade_batch_with_lease',
    'get_demo_scalping_entry_batch_with_lease',
    'close_demo_scalping_paper_trade_with_lease',
    'mark_demo_scalping_paper_trade_with_lease',
    'manage_demo_scalping_paper_exit_with_lease'
  ] loop
    select p.oid::regprocedure, p.proconfig
      into v_proc, v_config
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=v_name;

    if v_proc is null then
      raise exception 'Required worker RPC is missing: %', v_name;
    end if;

    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=v_name;
    if v_count <> 1 then
      raise exception 'Expected exactly one overload for worker RPC %, found %', v_name, v_count;
    end if;

    if not (select prosecdef from pg_proc where oid=v_proc) then
      raise exception 'Worker RPC % must be SECURITY DEFINER', v_name;
    end if;

    if not coalesce(v_config, '{}'::text[]) @> array['search_path=public, pg_temp']::text[] then
      raise exception 'Worker RPC % must pin search_path to public, pg_temp; found %', v_name, v_config;
    end if;

    if not has_function_privilege('service_role', v_proc, 'EXECUTE') then
      raise exception 'service_role must be able to execute worker RPC %', v_name;
    end if;

    if has_function_privilege('anon', v_proc, 'EXECUTE')
       or has_function_privilege('authenticated', v_proc, 'EXECUTE')
       or exists (
         select 1
           from pg_proc p,
                lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
          where p.oid=v_proc and a.grantee=0 and a.privilege_type='EXECUTE'
       ) then
      raise exception 'Worker RPC % must not be executable by PUBLIC, anon, or authenticated', v_name;
    end if;
  end loop;
end
$$;
