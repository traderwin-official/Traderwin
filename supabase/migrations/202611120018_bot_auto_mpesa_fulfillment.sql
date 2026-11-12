-- Complete automatic M-Pesa checkout and license delivery for standalone bot orders.
alter table public.bot_license_orders
  add column if not exists payment_phone text,
  add column if not exists mpesa_checkout_request_id text,
  add column if not exists mpesa_merchant_request_id text,
  add column if not exists mpesa_receipt_number text,
  add column if not exists mpesa_paid_phone text,
  add column if not exists mpesa_paid_amount numeric(12,2),
  add column if not exists payment_verified_at timestamptz;

alter table public.bot_license_orders drop constraint if exists bot_license_orders_status_check;
alter table public.bot_license_orders add constraint bot_license_orders_status_check
  check (status in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAYMENT_REVIEW','PAYMENT_FAILED','PAID','FULFILLED','CANCELLED'));

create unique index if not exists bot_license_orders_checkout_uidx
  on public.bot_license_orders(mpesa_checkout_request_id) where mpesa_checkout_request_id is not null;
create unique index if not exists bot_license_orders_receipt_uidx
  on public.bot_license_orders(mpesa_receipt_number) where mpesa_receipt_number is not null;

create table if not exists public.bot_license_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.bot_license_orders(id) on delete cascade,
  recipient_email text not null,
  encrypted_license_key text not null,
  status text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists bot_license_delivery_due_idx
  on public.bot_license_delivery_outbox(status,next_attempt_at);

update public.bot_products set product_name='TIGER SCHEME AI BOT — MT5 Lifetime',
  description='Standalone MetaTrader 5 Expert Advisor. Lifetime license for one MT5 trading account.'
  where product_code='MT5_GOLD_LIFETIME';
update public.bot_products set product_name='TIGER SCHEME AI BOT — MT5 Monthly',
  description='Standalone MetaTrader 5 Expert Advisor. Monthly license for one MT5 trading account.'
  where product_code='MT5_GOLD_MONTHLY';

alter table public.bot_license_delivery_outbox enable row level security;
revoke all on public.bot_license_delivery_outbox from anon, authenticated;
grant all on public.bot_license_delivery_outbox to service_role;

create or replace function public.fulfill_standalone_bot_order(
  p_order_id uuid,
  p_receipt text,
  p_amount numeric,
  p_phone text,
  p_license_key_hash text,
  p_encrypted_license_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.bot_license_orders%rowtype;
  p public.bot_products%rowtype;
begin
  select * into o from public.bot_license_orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status='FULFILLED' then return jsonb_build_object('status','ALREADY_FULFILLED'); end if;
  if o.status not in ('PAYMENT_PROCESSING','PENDING_PAYMENT') then raise exception 'ORDER_NOT_PAYABLE'; end if;
  if round(o.amount_kes,2) <> round(p_amount,2) then raise exception 'AMOUNT_MISMATCH'; end if;
  if o.payment_phone is not null and o.payment_phone <> p_phone then raise exception 'PHONE_MISMATCH'; end if;
  if exists(select 1 from public.bot_license_orders where mpesa_receipt_number=p_receipt and id<>p_order_id) then
    raise exception 'RECEIPT_ALREADY_USED';
  end if;
  select * into p from public.bot_products where product_code=o.product_code and active=true;
  if not found then raise exception 'PRODUCT_NOT_ACTIVE'; end if;

  update public.bot_license_orders set status='PAID', payment_reference=p_receipt,
    mpesa_receipt_number=p_receipt, mpesa_paid_phone=p_phone, mpesa_paid_amount=p_amount,
    payment_verified_at=now(), paid_at=now() where id=p_order_id;

  insert into public.bot_licenses(order_id,product_code,license_key_hash,license_type,expires_at)
  values(p_order_id,o.product_code,p_license_key_hash,p.license_type,
    case when p.license_type='MONTHLY' then now()+interval '30 days' else null end);

  insert into public.bot_license_delivery_outbox(order_id,recipient_email,encrypted_license_key)
  values(p_order_id,o.customer_email,p_encrypted_license_key);

  update public.bot_license_orders set status='FULFILLED',fulfilled_at=now() where id=p_order_id;
  return jsonb_build_object('status','FULFILLED');
end;
$$;
revoke all on function public.fulfill_standalone_bot_order(uuid,text,numeric,text,text,text) from public, anon, authenticated;
grant execute on function public.fulfill_standalone_bot_order(uuid,text,numeric,text,text,text) to service_role;
