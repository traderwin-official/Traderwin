-- Flutterwave hosted checkout for Traderwin service payments.
-- Initial implementation bills in KES; overseas card issuers may convert to the
-- cardholder's currency. Do not advertise direct USD settlement until enabled
-- and verified for the merchant account.

alter table public.payment_orders
  drop constraint if exists payment_orders_currency_check,
  drop constraint if exists payment_orders_payment_method_check;

alter table public.payment_orders
  add constraint payment_orders_currency_check check (currency = 'KES'),
  add constraint payment_orders_payment_method_check check (payment_method in ('MPESA','FLUTTERWAVE'));

alter table public.payment_orders
  add column if not exists flutterwave_tx_ref text,
  add column if not exists flutterwave_transaction_id text;

create unique index if not exists payment_orders_flutterwave_tx_ref_uidx
  on public.payment_orders(flutterwave_tx_ref) where flutterwave_tx_ref is not null;
create unique index if not exists payment_orders_flutterwave_transaction_uidx
  on public.payment_orders(flutterwave_transaction_id) where flutterwave_transaction_id is not null;

comment on column public.payment_orders.flutterwave_tx_ref is
  'Server-generated Flutterwave transaction reference; never supplied by the browser.';
comment on column public.payment_orders.flutterwave_transaction_id is
  'Flutterwave transaction ID confirmed by server-side verification.';
