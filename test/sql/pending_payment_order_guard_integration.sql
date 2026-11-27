-- Verify concurrent checkout requests cannot create duplicate pending orders
-- for one member/service, while later renewals remain possible.
begin;

insert into auth.users(id) values
  ('33333333-3333-4333-8333-333333333333')
on conflict (id) do nothing;

insert into public.service_catalog(service_code,active,billing_period)
values ('TEST_MEMBERSHIP',true,'MONTHLY')
on conflict (service_code) do nothing;

insert into public.payment_orders(user_id,service_code,status)
values ('33333333-3333-4333-8333-333333333333','TEST_MEMBERSHIP','PENDING');

do $$
declare
  v_rejected boolean := false;
begin
  begin
    insert into public.payment_orders(user_id,service_code,status)
    values ('33333333-3333-4333-8333-333333333333','TEST_MEMBERSHIP','PENDING');
  exception when unique_violation then
    v_rejected := true;
  end;

  if not v_rejected then
    raise exception 'A second pending checkout for the same member/service was accepted';
  end if;
end
$$;

update public.payment_orders
   set status='PAID'
 where user_id='33333333-3333-4333-8333-333333333333'
   and service_code='TEST_MEMBERSHIP'
   and status='PENDING';

insert into public.payment_orders(user_id,service_code,status)
values ('33333333-3333-4333-8333-333333333333','TEST_MEMBERSHIP','PENDING');

do $$
begin
  if (select count(*) from public.payment_orders
       where user_id='33333333-3333-4333-8333-333333333333'
         and service_code='TEST_MEMBERSHIP' and status='PENDING') <> 1 then
    raise exception 'A later renewal checkout was not allowed after prior payment';
  end if;
end
$$;

rollback;
