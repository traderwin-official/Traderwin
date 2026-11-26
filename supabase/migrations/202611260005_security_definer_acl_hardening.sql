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
  if to_regprocedure('public.is_traderwin_admin()') is not null then
    execute 'revoke all on function public.is_traderwin_admin() from public, anon';
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
