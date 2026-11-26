-- Restrict SECURITY DEFINER helpers to the roles that genuinely need them.
-- Trigger functions are invoked by PostgreSQL triggers; callers do not need
-- direct EXECUTE permission on the trigger function.
do $$
begin
  if to_regprocedure('public.audit_trading_instrument_approval()') is not null then
    execute 'revoke all on function public.audit_trading_instrument_approval() from public, anon, authenticated, service_role';
  end if;
  if to_regprocedure('public.traderwin_audit_account_mode()') is not null then
    execute 'revoke all on function public.traderwin_audit_account_mode() from public, anon, authenticated, service_role';
  end if;
  if to_regclass('public.trading_instrument_approval_audit') is not null then
    execute 'revoke all on table public.trading_instrument_approval_audit from service_role';
    execute 'grant select, insert on table public.trading_instrument_approval_audit to service_role';
  end if;
  if to_regclass('public.admin_users') is not null then
    execute 'alter table public.admin_users enable row level security';
    execute 'revoke all on table public.admin_users from public, anon, authenticated';
    execute 'grant select on table public.admin_users to authenticated';
    if not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='admin_users'
         and policyname='Users can check their own admin status'
    ) then
      execute 'create policy "Users can check their own admin status" on public.admin_users for select to authenticated using (user_id = auth.uid())';
    end if;
  end if;

  if to_regprocedure('public.is_traderwin_admin()') is not null then
    execute $sql$
      create or replace function public.is_traderwin_admin()
      returns boolean
      language sql
      stable
      security invoker
      set search_path=public
      as $function$
        select exists (select 1 from public.admin_users where user_id = auth.uid())
      $function$
    $sql$;
    execute 'revoke all on function public.is_traderwin_admin() from public, anon, service_role';
    execute 'grant execute on function public.is_traderwin_admin() to authenticated';
  end if;

  -- Keep the public catalogue public without making anonymous visitors execute
  -- the SECURITY DEFINER admin-check helper.
  if to_regclass('public.service_catalog') is not null then
    execute 'drop policy if exists "Public read active services" on public.service_catalog';
    execute 'drop policy if exists "Authenticated read active services" on public.service_catalog';
    execute 'create policy "Public read active services" on public.service_catalog for select to anon using (active = true)';
    if to_regprocedure('public.is_traderwin_admin()') is not null then
      execute 'create policy "Authenticated read active services" on public.service_catalog for select to authenticated using (active = true or is_traderwin_admin())';
    else
      execute 'create policy "Authenticated read active services" on public.service_catalog for select to authenticated using (active = true)';
    end if;
  end if;
end
$$;
