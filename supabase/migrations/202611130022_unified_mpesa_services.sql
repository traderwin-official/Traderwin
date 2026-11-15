-- Unified Traderwin M-Pesa services and entitlements.
-- All products use the same Daraja shortcode, credentials and callback URL.
-- DEMO and account registration stay free; payment is required per paid feature.

alter table public.payment_orders
  add column if not exists mpesa_paid_phone text,
  add column if not exists mpesa_paid_amount numeric(12,2),
  add column if not exists payment_verified_at timestamptz;

alter table public.payment_orders drop constraint if exists payment_orders_status_check;
alter table public.payment_orders add constraint payment_orders_status_check
  check (status in ('PENDING','PAYMENT_REVIEW','PAID','FAILED','CANCELLED','REFUNDED'));

create unique index if not exists payment_orders_provider_reference_uidx
  on public.payment_orders(provider_reference) where provider_reference is not null;

create table if not exists public.service_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service_code text not null references public.service_catalog(service_code),
  payment_order_id uuid not null unique references public.payment_orders(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED','EXPIRED')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists service_entitlements_user_service_idx
  on public.service_entitlements(user_id,service_code,status,ends_at);
alter table public.service_entitlements enable row level security;
drop policy if exists "Users read own service entitlements" on public.service_entitlements;
create policy "Users read own service entitlements" on public.service_entitlements
  for select to authenticated using (auth.uid()=user_id);
revoke all on public.service_entitlements from anon,authenticated;
grant select on public.service_entitlements to authenticated;
grant all on public.service_entitlements to service_role;

-- Suggested launch prices. Membership and DEMO are deliberately free.
insert into public.service_catalog
 (service_code,service_name,description,price_kes,billing_period,active)
values
 ('MEMBERSHIP','Free Traderwin Membership','Free account registration and member dashboard access.',0,'ONE_TIME',false),
 ('ADVANCED_BOT','Advanced Trading Bot','Monthly access to Traderwin advanced bot features. DEMO access remains free.',2500,'MONTHLY',true),
 ('SIGNALS','Premium Signals & AI Analysis','Monthly access to premium reviewed signals and AI market analysis.',1000,'MONTHLY',true),
 ('EDUCATION','Trading Education','Access to a published Traderwin education course.',1500,'ONE_TIME',true)
on conflict(service_code) do update set
 service_name=excluded.service_name,
 description=excluded.description,
 price_kes=excluded.price_kes,
 billing_period=excluded.billing_period,
 active=excluded.active;

-- Preserve the previously agreed REAL trading USD pricing.
update public.service_catalog
set service_name='REAL Trading Subscription',
    description='First month USD 75; later monthly renewals USD 175. DEMO remains free.',
    price_usd=75.00, renewal_price_usd=175.00,
    price_kes=0, billing_period='MONTHLY', active=true
where service_code='REAL_TRADING';

-- Standalone bot SKUs use the same M-Pesa shortcode but remain unpublished until
-- the compiled EA, download delivery and license enforcement have passed testing.
update public.bot_products set price_kes=2500, active=false
where product_code='MT5_GOLD_MONTHLY';
update public.bot_products set price_kes=12000, active=false
where product_code='MT5_GOLD_LIFETIME';
update public.bot_products set active=false
where broker='DERIV';

create or replace function public.fulfill_traderwin_service_payment(
  p_order_id uuid,
  p_receipt text,
  p_amount numeric,
  p_phone text
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  o public.payment_orders%rowtype;
  s public.service_catalog%rowtype;
  existing_end timestamptz;
  next_end timestamptz;
begin
  select * into o from public.payment_orders where id=p_order_id for update;
  if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;
  if o.status='PAID' then return jsonb_build_object('status','ALREADY_PAID'); end if;
  if o.status not in ('PENDING','PAYMENT_REVIEW') then raise exception 'PAYMENT_ORDER_NOT_PAYABLE'; end if;
  if round(o.amount_kes,2) <> round(p_amount,2) then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;
  if o.phone_number is not null and o.phone_number <> p_phone then raise exception 'PAYMENT_PHONE_MISMATCH'; end if;
  if exists(select 1 from public.payment_orders where provider_reference=p_receipt and id<>p_order_id) then
    raise exception 'MPESA_RECEIPT_ALREADY_USED';
  end if;
  select * into s from public.service_catalog where service_code=o.service_code and active=true;
  if not found then raise exception 'SERVICE_NOT_ACTIVE'; end if;

  update public.payment_orders set status='PAID',provider_reference=p_receipt,
    mpesa_paid_phone=p_phone,mpesa_paid_amount=p_amount,
    payment_verified_at=now(),confirmed_at=now()
  where id=p_order_id;

  if s.billing_period in ('MONTHLY','YEARLY') then
    select ends_at into existing_end from public.user_subscriptions
      where user_id=o.user_id and service_code=o.service_code for update;
    if existing_end is not null and existing_end>now() then
      next_end := existing_end + case when s.billing_period='YEARLY' then interval '1 year' else interval '1 month' end;
    else
      next_end := now() + case when s.billing_period='YEARLY' then interval '1 year' else interval '1 month' end;
    end if;
    insert into public.user_subscriptions(user_id,service_code,status,starts_at,ends_at,payment_order_id)
    values(o.user_id,o.service_code,'ACTIVE',now(),next_end,p_order_id)
    on conflict(user_id,service_code) do update set
      status='ACTIVE',starts_at=now(),ends_at=next_end,payment_order_id=p_order_id;
  else
    insert into public.service_entitlements(user_id,service_code,payment_order_id,status,starts_at,ends_at)
    values(o.user_id,o.service_code,p_order_id,'ACTIVE',now(),null)
    on conflict(payment_order_id) do nothing;
  end if;

  return jsonb_build_object('status','PAID','service_code',o.service_code);
end;
$$;
revoke all on function public.fulfill_traderwin_service_payment(uuid,text,numeric,text) from public,anon,authenticated;
grant execute on function public.fulfill_traderwin_service_payment(uuid,text,numeric,text) to service_role;

-- Premium signals and AI-generated trade ideas require an active SIGNALS subscription.
drop policy if exists "Anyone reads active unexpired signals" on public.trading_signals;
drop policy if exists "Paid subscribers read active unexpired signals" on public.trading_signals;
create policy "Paid subscribers read active unexpired signals"
  on public.trading_signals for select to authenticated
  using (
    status='ACTIVE' and (expires_at is null or expires_at>now())
    and exists (
      select 1 from public.user_subscriptions us
      where us.user_id=auth.uid() and us.service_code='SIGNALS'
        and us.status='ACTIVE' and us.ends_at>now()
    )
  );

drop policy if exists "Users read approved fresh AI ideas" on public.ai_trade_ideas;
drop policy if exists "Paid subscribers read approved fresh AI ideas" on public.ai_trade_ideas;
create policy "Paid subscribers read approved fresh AI ideas"
  on public.ai_trade_ideas for select to authenticated
  using (
    review_status='APPROVED' and (stale_after is null or stale_after>now())
    and exists (
      select 1 from public.user_subscriptions us
      where us.user_id=auth.uid() and us.service_code='SIGNALS'
        and us.status='ACTIVE' and us.ends_at>now()
    )
  );

comment on table public.service_entitlements is
  'One-time paid service access. Membership and DEMO remain free; monthly services are tracked in user_subscriptions.';
