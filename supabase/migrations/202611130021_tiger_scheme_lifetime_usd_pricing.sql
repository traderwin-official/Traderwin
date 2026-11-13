-- USD-denominated standalone bot pricing with auditable M-Pesa KES conversion.
-- The lifetime TIGER SCHEME AI BOT is USD 350, charged once.
alter table public.bot_products
  add column if not exists price_usd numeric(12,2);

alter table public.bot_products
  drop constraint if exists bot_products_price_usd_nonnegative,
  add constraint bot_products_price_usd_nonnegative
    check (price_usd is null or price_usd > 0);

alter table public.bot_license_orders
  add column if not exists amount_usd numeric(12,2),
  add column if not exists fx_rate_kes numeric(14,6),
  add column if not exists fx_source text,
  add column if not exists fx_as_of timestamptz;

alter table public.bot_license_orders
  drop constraint if exists bot_license_orders_amount_usd_positive,
  add constraint bot_license_orders_amount_usd_positive
    check (amount_usd is null or amount_usd > 0),
  drop constraint if exists bot_license_orders_fx_rate_positive,
  add constraint bot_license_orders_fx_rate_positive
    check (fx_rate_kes is null or fx_rate_kes > 0);

update public.bot_products
set product_name='TIGER SCHEME AI BOT — MT5 Lifetime',
    description='Standalone MetaTrader 5 Expert Advisor. USD 350 one-time lifetime license for one MT5 trading account. Compatible updates to this bot are included during its supported product lifetime.',
    price_usd=350.00,
    price_kes=null,
    currency='KES'
where product_code='MT5_GOLD_LIFETIME';

comment on column public.bot_products.price_usd is
  'Published USD retail price. M-Pesa checkout converts using a fresh server-side USD/KES rate.';
comment on column public.bot_license_orders.amount_usd is
  'USD product price snapshotted when the order was created.';
comment on column public.bot_license_orders.fx_rate_kes is
  'USD/KES rate used to calculate this exact M-Pesa checkout amount.';
