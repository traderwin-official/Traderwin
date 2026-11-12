-- Daraja STK Push automation and idempotent license fulfillment.
alter table public.bot_license_orders
  add column if not exists mpesa_checkout_request_id text,
  add column if not exists mpesa_merchant_request_id text,
  add column if not exists payment_phone text,
  add column if not exists delivery_status text not null default 'NOT_READY'
    check (delivery_status in ('NOT_READY','PENDING','DELIVERED','FAILED')),
  add column if not exists delivery_attempts integer not null default 0,
  add column if not exists last_delivery_error text,
  add column if not exists payment_result_code text,
  add column if not exists payment_result_desc text,
  add column if not exists payment_callback_received_at timestamptz;

create unique index if not exists bot_license_orders_checkout_uidx
  on public.bot_license_orders(mpesa_checkout_request_id)
  where mpesa_checkout_request_id is not null;
create unique index if not exists bot_license_orders_mpesa_receipt_uidx
  on public.bot_license_orders(payment_reference)
  where payment_reference is not null;

alter table public.bot_licenses
  add column if not exists license_key_ciphertext text;

alter table public.bot_license_orders drop constraint if exists bot_license_orders_status_check;
alter table public.bot_license_orders add constraint bot_license_orders_status_check
  check (status in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAYMENT_REVIEW','PAID','FULFILLED','CANCELLED'));

create or replace function public.finalize_standalone_bot_payment(
  p_checkout_request_id text,
  p_receipt text,
  p_amount numeric,
  p_phone text,
  p_result_code text,
  p_result_desc text,
  p_license_key_hash text,
  p_license_key_ciphertext text
) returns table(order_id uuid, customer_email text, customer_name text, license_type text, expires_at timestamptz, key_ciphertext text, already_fulfilled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.bot_license_orders%rowtype;
  prod public.bot_products%rowtype;
  lic public.bot_licenses%rowtype;
begin
  if coalesce(p_result_code,'') <> '0' or coalesce(p_receipt,'') = '' then
    raise exception 'Payment is not confirmed';
  end if;
  select * into o from public.bot_license_orders
    where mpesa_checkout_request_id = p_checkout_request_id
    for update;
  if not found then raise exception 'Unknown checkout request'; end if;
  if round(o.amount_kes,0) <> round(p_amount,0) then raise exception 'Payment amount mismatch'; end if;
  if regexp_replace(coalesce(o.customer_phone,''),'[^0-9]','','g') <> regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') then
    raise exception 'Payment phone mismatch';
  end if;
  if o.status = 'FULFILLED' then
    select * into lic from public.bot_licenses where bot_licenses.order_id = o.id;
    if not found then raise exception 'Fulfilled order has no license'; end if;
    return query select o.id,o.customer_email,o.customer_name,lic.license_type,lic.expires_at,lic.license_key_ciphertext,true;
    return;
  end if;
  if o.status not in ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAYMENT_REVIEW') then
    raise exception 'Order is not payable';
  end if;
  if exists(select 1 from public.bot_license_orders x where x.payment_reference=p_receipt and x.id<>o.id) then
    raise exception 'M-Pesa receipt already used';
  end if;
  select * into prod from public.bot_products where product_code=o.product_code and active=true;
  if not found then raise exception 'Product unavailable'; end if;
  insert into public.bot_licenses(order_id,product_code,license_key_hash,license_type,expires_at,license_key_ciphertext)
  values(o.id,o.product_code,p_license_key_hash,prod.license_type,
    case when prod.license_type='MONTHLY' then now()+interval '30 days' else null end,
    p_license_key_ciphertext)
  on conflict(order_id) do nothing;
  select * into lic from public.bot_licenses where bot_licenses.order_id=o.id;
  update public.bot_license_orders set
    status='FULFILLED', payment_reference=p_receipt, payment_phone=p_phone,
    payment_result_code=p_result_code, payment_result_desc=p_result_desc,
    paid_at=coalesce(paid_at,now()), fulfilled_at=coalesce(fulfilled_at,now()),
    delivery_status=case when delivery_status='DELIVERED' then 'DELIVERED' else 'PENDING' end,
    payment_callback_received_at=coalesce(payment_callback_received_at,now())
    where id=o.id;
  return query select o.id,o.customer_email,o.customer_name,lic.license_type,lic.expires_at,lic.license_key_ciphertext,false;
end;
$$;

revoke all on function public.finalize_standalone_bot_payment(text,text,numeric,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.finalize_standalone_bot_payment(text,text,numeric,text,text,text,text,text) to service_role;
