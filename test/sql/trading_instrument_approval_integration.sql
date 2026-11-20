-- Disposable PostgreSQL integration checks for the server-managed instrument allowlist.
do $$
declare
  v_user uuid;
  v_approval uuid;
  v_count integer;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into auth.users default values returning id into v_user;

  insert into public.trading_instrument_approvals(
    broker,instrument,provider,provider_symbol,status,is_active
  ) values ('DERIV','R_100','DERIV','R_100','PENDING',false)
  returning id into v_approval;

  select count(*) into v_count from public.trading_instrument_approval_audit
   where approval_id=v_approval and operation='INSERT';
  if v_count<>1 then raise exception 'Expected insert audit event, got %',v_count; end if;

  update public.trading_instrument_approvals
     set status='APPROVED',is_active=true,approved_by=v_user,approved_at=now(),
         approval_note='CI approved fixture',updated_at=now()
   where id=v_approval;

  select count(*) into v_count from public.trading_instrument_approval_audit
   where approval_id=v_approval and operation='UPDATE'
     and old_record->>'status'='PENDING'
     and new_record->>'status'='APPROVED';
  if v_count<>1 then raise exception 'Expected approval audit event, got %',v_count; end if;

  if not (select relrowsecurity from pg_class where oid='public.trading_instrument_approvals'::regclass) then
    raise exception 'Instrument approval registry must have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.trading_instrument_approval_audit'::regclass) then
    raise exception 'Instrument approval audit must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.trading_instrument_approvals','SELECT')
     or has_table_privilege('authenticated','public.trading_instrument_approvals','SELECT')
     or has_table_privilege('anon','public.trading_instrument_approval_audit','SELECT')
     or has_table_privilege('authenticated','public.trading_instrument_approval_audit','SELECT') then
    raise exception 'Browser roles must not read instrument approvals or audit records';
  end if;
  if not has_table_privilege('service_role','public.trading_instrument_approvals','SELECT')
     or not has_table_privilege('service_role','public.trading_instrument_approvals','UPDATE')
     or not has_table_privilege('service_role','public.trading_instrument_approval_audit','SELECT') then
    raise exception 'Service role privileges are incomplete';
  end if;

  begin
    insert into public.trading_instrument_approvals(
      broker,instrument,provider,provider_symbol,status,is_active,approved_at
    ) values ('DERIV','XAUUSD','DERIV','XAUUSD','APPROVED',true,now());
    raise exception 'Expected approved row without approver to fail';
  exception when check_violation then
    null;
  end;
end
$$;
