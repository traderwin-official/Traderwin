DO $test$
DECLARE
  v_service_id uuid;
  v_order_id uuid;
  v_user uuid := '11111111-1111-4111-8111-111111111111';
  v_paid_at timestamptz;
BEGIN
  SELECT id INTO v_service_id
    FROM public.service_catalog
   WHERE service_name = 'Legacy Course';

  IF v_service_id IS NULL THEN
    RAISE EXCEPTION 'Legacy service fixture is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_catalog
     WHERE id = v_service_id
       AND price_kes = 1500
       AND price_usd IS NULL
       AND renewal_price_usd IS NULL
       AND service_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy KES catalogue amount was not preserved without inventing a service code or USD price';
  END IF;

  SELECT id, paid_at INTO v_order_id, v_paid_at
    FROM public.payment_orders
   WHERE provider_checkout_id = 'ws_CO_LEGACY';

  IF v_order_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.payment_orders
     WHERE id = v_order_id
       AND amount_kes = 1500
       AND amount_usd IS NULL
       AND checkout_request_id = 'ws_CO_LEGACY'
       AND provider_reference = 'RCP_LEGACY'
       AND confirmed_at = v_paid_at
  ) THEN
    RAISE EXCEPTION 'Legacy payment order fields were not mapped to the current checkout contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'service_catalog_service_code_uidx',
         'payment_orders_checkout_request_id_uidx',
         'payment_orders_provider_reference_uidx',
         'user_subscriptions_user_service_uidx'
       )
     GROUP BY schemaname
    HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'Expected payment schema unique indexes were not created';
  END IF;

  -- The unique conflict target required by the current subscription upsert must work.
  INSERT INTO public.user_subscriptions(
    user_id,service_code,status,amount,currency,starts_at,payment_order_id
  ) VALUES (
    v_user,'LEGACY_COURSE','ACTIVE',1500,'KES',now(),v_order_id
  )
  ON CONFLICT (user_id,service_code) DO UPDATE
    SET amount = EXCLUDED.amount, currency = EXCLUDED.currency;

  IF (SELECT count(*) FROM public.user_subscriptions
       WHERE user_id = v_user AND service_code = 'LEGACY_COURSE') <> 1 THEN
    RAISE EXCEPTION 'Subscription upsert created duplicate user/service rows';
  END IF;

  -- New keyed catalogue entries must be unique.
  UPDATE public.service_catalog SET service_code = 'LEGACY_COURSE'
   WHERE id = v_service_id;

  BEGIN
    INSERT INTO public.service_catalog(
      service_code,service_name,service_type,price,currency,billing_period,price_kes
    ) VALUES (
      'LEGACY_COURSE','Duplicate Course','COURSE',1,'KES','ONE_TIME',1
    );
    RAISE EXCEPTION 'Duplicate service_code unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- The new checkout reference is independently unique, even when legacy aliases differ.
  BEGIN
    INSERT INTO public.payment_orders(
      user_id,service_code,amount,amount_kes,currency,payment_method,
      provider_checkout_id,checkout_request_id,status
    ) VALUES (
      v_user,'LEGACY_COURSE',1,1,'KES','MPESA',
      'ws_CO_DIFFERENT','ws_CO_LEGACY','PENDING'
    );
    RAISE EXCEPTION 'Duplicate checkout_request_id unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$test$;
