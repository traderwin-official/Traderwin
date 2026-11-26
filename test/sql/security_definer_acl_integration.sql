\set ON_ERROR_STOP on
do $$
begin
  if to_regprocedure('public.audit_trading_instrument_approval()') is not null then
    if has_function_privilege('anon','public.audit_trading_instrument_approval()','EXECUTE')
       or has_function_privilege('authenticated','public.audit_trading_instrument_approval()','EXECUTE')
       or has_function_privilege('service_role','public.audit_trading_instrument_approval()','EXECUTE') then
      raise exception 'Approval audit trigger function must not be directly executable by API roles';
    end if;
  end if;
  if to_regprocedure('public.traderwin_audit_account_mode()') is not null then
    if has_function_privilege('anon','public.traderwin_audit_account_mode()','EXECUTE')
       or has_function_privilege('authenticated','public.traderwin_audit_account_mode()','EXECUTE')
       or has_function_privilege('service_role','public.traderwin_audit_account_mode()','EXECUTE') then
      raise exception 'Account mode audit trigger function must not be directly executable by API roles';
    end if;
  end if;
  if to_regprocedure('public.is_traderwin_admin()') is not null then
    if has_function_privilege('anon','public.is_traderwin_admin()','EXECUTE')
       or not has_function_privilege('authenticated','public.is_traderwin_admin()','EXECUTE') then
      raise exception 'Admin helper must be callable only by authenticated users';
    end if;
  end if;
  if to_regprocedure('public.is_traderwin_admin()') is not null then
    if (select prosecdef from pg_proc where oid='public.is_traderwin_admin()'::regprocedure) then
      raise exception 'Admin helper must run as SECURITY INVOKER';
    end if;
    if has_function_privilege('anon','public.is_traderwin_admin()','EXECUTE')
       or not has_function_privilege('authenticated','public.is_traderwin_admin()','EXECUTE') then
      raise exception 'Admin helper must be callable only by authenticated users';
    end if;
    if has_table_privilege('anon','public.admin_users','SELECT')
       or has_table_privilege('authenticated','public.admin_users','INSERT')
       or has_table_privilege('authenticated','public.admin_users','UPDATE')
       or has_table_privilege('authenticated','public.admin_users','DELETE')
       or not has_table_privilege('authenticated','public.admin_users','SELECT') then
      raise exception 'Admin table must expose self-read only to authenticated users';
    end if;
  end if;
  if to_regclass('public.trading_instrument_approval_audit') is not null then
    if has_table_privilege('service_role','public.trading_instrument_approval_audit','UPDATE')
       or has_table_privilege('service_role','public.trading_instrument_approval_audit','DELETE')
       or has_table_privilege('service_role','public.trading_instrument_approval_audit','TRUNCATE')
       or not has_table_privilege('service_role','public.trading_instrument_approval_audit','INSERT')
       or not has_table_privilege('service_role','public.trading_instrument_approval_audit','SELECT') then
      raise exception 'Approval audit table must be append-only for service role';
    end if;
  end if;
  if to_regclass('public.service_catalog') is not null then
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_catalog' and policyname='Public read active services' and roles @> array['anon']::name[]) then
      raise exception 'Anonymous active catalogue policy missing';
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='service_catalog' and policyname='Authenticated read active services' and roles @> array['authenticated']::name[]) then
      raise exception 'Authenticated catalogue policy missing';
    end if;
  end if;
end
$$;
