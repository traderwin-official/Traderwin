-- Validates permanent order-level idempotency and serialized renewals.
begin;
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000101')
on conflict do nothing;
insert into public.service_catalog(service_code,service_name,service_type,price,currency,billing_period,active)
values ('TEST_REAL_TRADING','Test REAL subscription','PREMIUM_TOOL',0,'KES','MONTHLY',true);

insert into public.payment_orders(id,user_id,service_code,amount,currency,amount_kes,amount_usd,status) values
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101','TEST_REAL_TRADING',9000,'KES',9000,75,'PAID');

do $$
declare
  v_first jsonb;
  v_replay jsonb;
  v_before timestamptz;
  v_after timestamptz;
begin
  v_first := public.fulfill_paid_subscription_order('00000000-0000-0000-0000-000000000201');
  if v_first->>'status' <> 'APPLIED' then raise exception 'First fulfilment was not applied: %', v_first; end if;
  IF NOT EXISTS (SELECT 1 FROM public.user_subscriptions
      WHERE user_id='00000000-0000-0000-0000-000000000101'
        AND service_code='TEST_REAL_TRADING' AND amount=75 AND currency='USD') THEN
    RAISE EXCEPTION 'First USD subscription amount/currency was not persisted';
  END IF;

  select ends_at into v_before from public.user_subscriptions
   where user_id='00000000-0000-0000-0000-000000000101' and service_code='TEST_REAL_TRADING';

  -- A duplicate callback for the same order must never extend the term again.
  v_replay := public.fulfill_paid_subscription_order('00000000-0000-0000-0000-000000000201');
  if v_replay->>'status' <> 'ALREADY_APPLIED' then raise exception 'Duplicate order was not deduplicated: %', v_replay; end if;

  select ends_at into v_after from public.user_subscriptions
   where user_id='00000000-0000-0000-0000-000000000101' and service_code='TEST_REAL_TRADING';
  if v_before is distinct from v_after then raise exception 'Duplicate callback changed subscription expiry'; end if;

  -- A later, distinct paid order renews once; replaying the old order afterward
  -- must still be caught by the permanent ledger.
  insert into public.payment_orders(id,user_id,service_code,amount,currency,amount_kes,amount_usd,status) values
   ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000101','TEST_REAL_TRADING',21000,'KES',21000,175,'PAID');
  if public.fulfill_paid_subscription_order('00000000-0000-0000-0000-000000000202')->>'status' <> 'APPLIED' then
    raise exception 'Second paid order did not renew';
  end if;
  IF NOT EXISTS (SELECT 1 FROM public.user_subscriptions
      WHERE user_id='00000000-0000-0000-0000-000000000101'
        AND service_code='TEST_REAL_TRADING' AND amount=175 AND currency='USD') THEN
    RAISE EXCEPTION 'Renewal USD amount/currency was not persisted';
  END IF;
  select ends_at into v_before from public.user_subscriptions
   where user_id='00000000-0000-0000-0000-000000000101' and service_code='TEST_REAL_TRADING';

  v_replay := public.fulfill_paid_subscription_order('00000000-0000-0000-0000-000000000201');
  if v_replay->>'status' <> 'ALREADY_APPLIED' then raise exception 'Historical replay was not deduplicated: %', v_replay; end if;
  select ends_at into v_after from public.user_subscriptions
   where user_id='00000000-0000-0000-0000-000000000101' and service_code='TEST_REAL_TRADING';
  if v_before is distinct from v_after then raise exception 'Historical replay changed subscription expiry'; end if;

  if (select count(*) from public.subscription_entitlement_events
       where user_id='00000000-0000-0000-0000-000000000101') <> 2 then
    raise exception 'Expected exactly two permanent entitlement events';
  end if;
end;
$$;
rollback;
