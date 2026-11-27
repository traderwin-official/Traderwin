-- Seed the already owner-approved REAL subscription price.
-- DEMO remains free. Paying for this subscription never authorizes live execution.
insert into public.service_catalog (
  service_code, service_name, service_type, description,
  price, currency, billing_period, active,
  price_kes, price_usd, renewal_price_usd
)
values (
  'REAL_TRADING',
  'REAL Trading Subscription',
  'PREMIUM_TOOL',
  'First month USD 75; subsequent monthly renewals USD 175. DEMO access remains free. Payment alone does not unlock broker execution.',
  0,
  'KES',
  'MONTHLY',
  true,
  0,
  75.00,
  175.00
)
on conflict (service_code) do update set
  service_name = excluded.service_name,
  service_type = excluded.service_type,
  description = excluded.description,
  price = excluded.price,
  currency = excluded.currency,
  billing_period = excluded.billing_period,
  active = true,
  price_kes = excluded.price_kes,
  price_usd = excluded.price_usd,
  renewal_price_usd = excluded.renewal_price_usd;
