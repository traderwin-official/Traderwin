-- Standalone bot sales do not require a Traderwin auth.users account.
create table if not exists public.bot_products (
  product_code text primary key,
  product_name text not null,
  broker text not null check (broker in ('MT5','DERIV')),
  license_type text not null check (license_type in ('LIFETIME','MONTHLY')),
  price_kes numeric(12,2),
  currency text not null default 'KES' check (currency='KES'),
  description text not null default '',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (price_kes is null or price_kes > 0)
);

create table if not exists public.bot_license_orders (
  id uuid primary key default gen_random_uuid(),
  product_code text not null references public.bot_products(product_code),
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  mt5_login text,
  mt5_server text,
  payment_method text not null default 'MPESA' check (payment_method='MPESA'),
  payment_reference text,
  amount_kes numeric(12,2) not null check (amount_kes > 0),
  status text not null default 'PENDING_PAYMENT'
    check (status in ('PENDING_PAYMENT','PAYMENT_REVIEW','PAID','FULFILLED','CANCELLED')),
  admin_note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  fulfilled_at timestamptz
);

create table if not exists public.bot_licenses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.bot_license_orders(id),
  product_code text not null references public.bot_products(product_code),
  license_key_hash text not null unique,
  license_type text not null check (license_type in ('LIFETIME','MONTHLY')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','REVOKED','EXPIRED')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  bound_mt5_login text,
  bound_mt5_server text,
  activated_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists bot_license_orders_email_idx on public.bot_license_orders (lower(customer_email), created_at desc);
create index if not exists bot_licenses_status_idx on public.bot_licenses (status, expires_at);

-- Products are deliberately inactive until Traderwin sets and verifies retail prices.
insert into public.bot_products (product_code,product_name,broker,license_type,description,active)
values
 ('MT5_GOLD_LIFETIME','Traderwin MT5 Gold EA — Lifetime','MT5','LIFETIME','Standalone MetaTrader 5 Expert Advisor. One licensed MT5 trading account.',false),
 ('MT5_GOLD_MONTHLY','Traderwin MT5 Gold EA — Monthly','MT5','MONTHLY','Standalone MetaTrader 5 Expert Advisor with a monthly license.',false),
 ('DERIV_BOT_LIFETIME','Traderwin Deriv Bot — Lifetime','DERIV','LIFETIME','Standalone Deriv automation product. Availability subject to account and API compatibility.',false),
 ('DERIV_BOT_MONTHLY','Traderwin Deriv Bot — Monthly','DERIV','MONTHLY','Standalone Deriv automation product with a monthly license.',false)
on conflict (product_code) do nothing;

alter table public.bot_products enable row level security;
alter table public.bot_license_orders enable row level security;
alter table public.bot_licenses enable row level security;

-- No anonymous or member direct table access. Server endpoints use service-role credentials.
revoke all on public.bot_products, public.bot_license_orders, public.bot_licenses from anon, authenticated;
grant all on public.bot_products, public.bot_license_orders, public.bot_licenses to service_role;
