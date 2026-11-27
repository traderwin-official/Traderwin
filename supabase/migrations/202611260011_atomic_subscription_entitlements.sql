-- Atomic, replay-proof subscription entitlement fulfilment for verified M-Pesa orders.
-- Every paid order can extend a subscription exactly once, even after later renewals.
create table if not exists public.subscription_entitlement_events (
  payment_order_id uuid primary key references public.payment_orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  service_code text not null references public.service_catalog(service_code),
  billing_period text not null check (billing_period in ('ONE_TIME','MONTHLY','YEARLY')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  applied_at timestamptz not null default now()
);

create index if not exists subscription_entitlement_events_user_service_idx
  on public.subscription_entitlement_events(user_id, service_code, applied_at desc);

alter table public.subscription_entitlement_events enable row level security;
revoke all on public.subscription_entitlement_events from public, anon, authenticated;
grant all on public.subscription_entitlement_events to service_role;

create or replace function public.fulfill_paid_subscription_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.payment_orders%rowtype;
  v_subscription public.user_subscriptions%rowtype;
  v_period text;
  v_now timestamptz := clock_timestamp();
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_event_id uuid;
  v_amount numeric;
  v_currency text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_order_id is null then raise exception 'ORDER_ID_REQUIRED'; end if;

  select * into v_order
    from public.payment_orders
   where id = p_order_id
   for update;
  if not found then raise exception 'PAYMENT_ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'PAID' then raise exception 'PAYMENT_ORDER_NOT_PAID'; end if;

  select billing_period into v_period
    from public.service_catalog
   where service_code = v_order.service_code;
  if not found then raise exception 'SUBSCRIPTION_SERVICE_NOT_FOUND'; end if;

  -- Preserve the purchased subscription price in the legacy NOT NULL columns.
  -- USD-priced services store the USD list price; KES-only services store KES.
  v_amount := case
    when coalesce(v_order.amount_usd, 0) > 0 then v_order.amount_usd
    else coalesce(v_order.amount_kes, v_order.amount)
  end;
  v_currency := case
    when coalesce(v_order.amount_usd, 0) > 0 then 'USD'
    else coalesce(nullif(upper(v_order.currency), ''), 'KES')
  end;
  if v_amount is null or v_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_REQUIRED';
  end if;

  -- Serialize renewals for this member/service, including the first subscription row.
  perform pg_advisory_xact_lock(hashtext(v_order.user_id::text || ':' || v_order.service_code));

  -- The ledger is append-only for the life of each payment order. This catches
  -- old callback replays even after a newer order has replaced payment_order_id.
  insert into public.subscription_entitlement_events (
    payment_order_id, user_id, service_code, billing_period, starts_at, ends_at
  )
  values (v_order.id, v_order.user_id, v_order.service_code, v_period, v_now, null)
  on conflict (payment_order_id) do nothing
  returning payment_order_id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'payment_order_id', v_order.id);
  end if;

  select * into v_subscription
    from public.user_subscriptions
   where user_id = v_order.user_id
     and service_code = v_order.service_code
   for update;

  v_starts_at := case
    when v_subscription.ends_at is not null and v_subscription.ends_at > v_now
      then v_subscription.ends_at
    else v_now
  end;

  if v_period = 'MONTHLY' then
    v_ends_at := v_starts_at + interval '1 month';
  elsif v_period = 'YEARLY' then
    v_ends_at := v_starts_at + interval '1 year';
  else
    v_starts_at := v_now;
    v_ends_at := null;
  end if;

  update public.subscription_entitlement_events
     set starts_at = v_starts_at, ends_at = v_ends_at
   where payment_order_id = v_order.id;

  insert into public.user_subscriptions (
    user_id, service_code, status, amount, currency, starts_at, ends_at, payment_order_id
  )
  values (
    v_order.user_id, v_order.service_code, 'ACTIVE', v_amount, v_currency,
    v_starts_at, v_ends_at, v_order.id
  )
  on conflict (user_id, service_code) do update
    set status = 'ACTIVE',
        amount = excluded.amount,
        currency = excluded.currency,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        payment_order_id = excluded.payment_order_id;

  return jsonb_build_object(
    'status', 'APPLIED',
    'payment_order_id', v_order.id,
    'starts_at', v_starts_at,
    'ends_at', v_ends_at
  );
end;
$$;

revoke all on function public.fulfill_paid_subscription_order(uuid)
  from public, anon, authenticated;
grant execute on function public.fulfill_paid_subscription_order(uuid) to service_role;
