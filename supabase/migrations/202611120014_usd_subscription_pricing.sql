-- Traderwin USD subscription pricing and auditable KES checkout snapshots.
-- REAL trading access is a paid service; DEMO remains free.
alter table public.service_catalog
  add column if not exists price_usd numeric(12,2),
  add column if not exists renewal_price_usd numeric(12,2);

alter table public.service_catalog
  drop constraint if exists service_catalog_price_usd_nonnegative,
  add constraint service_catalog_price_usd_nonnegative
    check (price_usd is null or price_usd >= 0),
  drop constraint if exists service_catalog_renewal_price_usd_nonnegative,
  add constraint service_catalog_renewal_price_usd_nonnegative
    check (renewal_price_usd is null or renewal_price_usd >= 0);

insert into public.service_catalog
  (service_code, service_name, description, price_kes, billing_period, price_usd, renewal_price_usd, active)
values
  ('REAL_TRADING', 'REAL Trading Subscription',
   'First month USD 75; subsequent monthly renewals USD 175. DEMO access remains free.',
   0, 'MONTHLY', 75.00, 175.00, true)
on conflict (service_code) do update set
  service_name = excluded.service_name,
  description = excluded.description,
  price_kes = 0,
  billing_period = 'MONTHLY',
  price_usd = excluded.price_usd,
  renewal_price_usd = excluded.renewal_price_usd,
  active = true;

-- Free registration and unpriced add-on services must not masquerade as payable products.
update public.service_catalog set active = false
where service_code = 'MEMBERSHIP';
update public.service_catalog set active = false
where service_code in ('EDUCATION', 'SIGNALS', 'ADVANCED_BOT')
  and coalesce(price_kes, 0) = 0
  and price_usd is null;

alter table public.payment_orders
  add column if not exists amount_usd numeric(12,2),
  add column if not exists fx_rate_kes numeric(14,6),
  add column if not exists fx_source text,
  add column if not exists fx_as_of timestamptz,
  add column if not exists price_basis text;

alter table public.payment_orders
  drop constraint if exists payment_orders_amount_usd_positive,
  add constraint payment_orders_amount_usd_positive
    check (amount_usd is null or amount_usd > 0),
  drop constraint if exists payment_orders_fx_rate_positive,
  add constraint payment_orders_fx_rate_positive
    check (fx_rate_kes is null or fx_rate_kes > 0),
  drop constraint if exists payment_orders_price_basis_valid,
  add constraint payment_orders_price_basis_valid
    check (price_basis is null or price_basis in ('FIXED_KES','FIRST_MONTH','RENEWAL'));

comment on column public.service_catalog.price_usd is
  'USD list price for the first purchase. KES checkout amount is calculated server-side.';
comment on column public.service_catalog.renewal_price_usd is
  'USD price for later monthly renewals; used only after a prior confirmed paid order.';
comment on column public.payment_orders.fx_rate_kes is
  'Server-captured USD/KES rate used to calculate this exact M-Pesa amount.';
comment on column public.payment_orders.fx_as_of is
  'Timestamp of the exchange-rate source used for the payment snapshot.';
