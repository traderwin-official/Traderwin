CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text NOT NULL,
  service_type text NOT NULL CHECK (service_type IN ('BOT','MEMBERSHIP','COURSE','SIGNALS','PREMIUM_TOOL')),
  description text,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'KES',
  billing_period text NOT NULL DEFAULT 'ONE_TIME'
    CHECK (billing_period IN ('ONE_TIME','DAILY','WEEKLY','MONTHLY','YEARLY')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  service_code text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  payment_method text NOT NULL DEFAULT 'MPESA',
  phone_number text,
  provider_checkout_id text UNIQUE,
  provider_receipt text UNIQUE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','CANCELLED','REFUNDED')),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE TABLE public.user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  service_code text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  starts_at timestamptz,
  ends_at timestamptz,
  payment_order_id uuid REFERENCES public.payment_orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $seed$
DECLARE
  v_user uuid := '11111111-1111-4111-8111-111111111111';
  v_order uuid;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_user);

  INSERT INTO public.service_catalog(service_name,service_type,description,price,currency,billing_period,active)
  VALUES ('Legacy Course','COURSE','Legacy KES catalogue row',1500,'KES','ONE_TIME',true);

  INSERT INTO public.payment_orders(
    user_id,service_code,amount,currency,payment_method,phone_number,
    provider_checkout_id,provider_receipt,status,paid_at
  ) VALUES (
    v_user,'LEGACY_COURSE',1500,'KES','MPESA','254712345678',
    'ws_CO_LEGACY','RCP_LEGACY','PAID','2026-11-20T10:00:00Z'
  ) RETURNING id INTO v_order;

  INSERT INTO public.user_subscriptions(
    user_id,service_code,status,amount,currency,starts_at,payment_order_id
  ) VALUES (
    v_user,'LEGACY_COURSE','ACTIVE',1500,'KES','2026-11-20T10:00:00Z',v_order
  );
END
$seed$;
