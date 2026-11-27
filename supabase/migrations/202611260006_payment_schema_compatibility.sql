-- Forward compatibility for legacy Traderwin payment tables.
-- Keep legacy columns intact while exposing the audited schema used by current handlers.
-- No catalogue rows or prices are seeded here; owner-approved pricing remains a separate step.

BEGIN;

ALTER TABLE public.service_catalog
  ADD COLUMN IF NOT EXISTS service_code text,
  ADD COLUMN IF NOT EXISTS price_kes numeric(12,2),
  ADD COLUMN IF NOT EXISTS price_usd numeric(12,2),
  ADD COLUMN IF NOT EXISTS renewal_price_usd numeric(12,2);

-- Preserve only amounts already denominated in KES. Never infer an FX conversion.
UPDATE public.service_catalog
   SET price_kes = price
 WHERE price_kes IS NULL
   AND upper(currency) = 'KES'
   AND price >= 0;

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS amount_kes numeric(12,2),
  ADD COLUMN IF NOT EXISTS amount_usd numeric(12,2),
  ADD COLUMN IF NOT EXISTS fx_rate_kes numeric(14,6),
  ADD COLUMN IF NOT EXISTS fx_source text,
  ADD COLUMN IF NOT EXISTS fx_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS price_basis text,
  ADD COLUMN IF NOT EXISTS checkout_request_id text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Backfill only directly equivalent legacy fields; do not manufacture USD or FX data.
UPDATE public.payment_orders
   SET amount_kes = amount
 WHERE amount_kes IS NULL
   AND upper(currency) = 'KES'
   AND amount > 0;

UPDATE public.payment_orders
   SET checkout_request_id = provider_checkout_id
 WHERE checkout_request_id IS NULL
   AND provider_checkout_id IS NOT NULL;

UPDATE public.payment_orders
   SET provider_reference = provider_receipt
 WHERE provider_reference IS NULL
   AND provider_receipt IS NOT NULL;

UPDATE public.payment_orders
   SET confirmed_at = paid_at
 WHERE confirmed_at IS NULL
   AND paid_at IS NOT NULL;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.service_catalog
     WHERE service_code IS NOT NULL
     GROUP BY service_code HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Payment schema compatibility: duplicate service_code values need reconciliation before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_subscriptions
     GROUP BY user_id, service_code HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Payment schema compatibility: duplicate user/service subscriptions need reconciliation before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_orders
     WHERE checkout_request_id IS NOT NULL
     GROUP BY checkout_request_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Payment schema compatibility: duplicate checkout references need reconciliation before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_orders
     WHERE provider_reference IS NOT NULL
     GROUP BY provider_reference HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Payment schema compatibility: duplicate provider receipts need reconciliation before migration';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_service_code_uidx
  ON public.service_catalog(service_code)
  WHERE service_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_checkout_request_id_uidx
  ON public.payment_orders(checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_provider_reference_uidx
  ON public.payment_orders(provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_user_service_uidx
  ON public.user_subscriptions(user_id, service_code);

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.service_catalog'::regclass
       AND conname = 'service_catalog_price_kes_nonnegative'
  ) THEN
    ALTER TABLE public.service_catalog
      ADD CONSTRAINT service_catalog_price_kes_nonnegative
      CHECK (price_kes IS NULL OR price_kes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.service_catalog'::regclass
       AND conname = 'service_catalog_price_usd_nonnegative'
  ) THEN
    ALTER TABLE public.service_catalog
      ADD CONSTRAINT service_catalog_price_usd_nonnegative
      CHECK (price_usd IS NULL OR price_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.service_catalog'::regclass
       AND conname = 'service_catalog_renewal_price_usd_nonnegative'
  ) THEN
    ALTER TABLE public.service_catalog
      ADD CONSTRAINT service_catalog_renewal_price_usd_nonnegative
      CHECK (renewal_price_usd IS NULL OR renewal_price_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_orders_amount_kes_positive'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_amount_kes_positive
      CHECK (amount_kes IS NULL OR amount_kes > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_orders_amount_usd_positive'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_amount_usd_positive
      CHECK (amount_usd IS NULL OR amount_usd > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_orders_fx_rate_positive'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_fx_rate_positive
      CHECK (fx_rate_kes IS NULL OR fx_rate_kes > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_orders_price_basis_valid'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_orders_price_basis_valid
      CHECK (price_basis IS NULL OR price_basis IN ('FIXED_KES', 'FIRST_MONTH', 'RENEWAL'));
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.service_catalog.service_code IS
  'Stable service identifier used by current server-side checkout handlers; legacy rows remain unmapped until explicitly reviewed.';
COMMENT ON COLUMN public.payment_orders.amount_kes IS
  'Exact KES amount requested from Daraja; backfilled only from legacy KES-denominated amount.';
COMMENT ON COLUMN public.payment_orders.amount_usd IS
  'USD catalogue amount captured at checkout; null for legacy orders without a verified USD price.';
COMMENT ON COLUMN public.payment_orders.fx_rate_kes IS
  'Server-captured USD/KES rate used for this exact checkout; never inferred during migration.';
COMMENT ON COLUMN public.payment_orders.confirmed_at IS
  'Provider-confirmed payment time; backfilled from legacy paid_at when available.';

COMMIT;
