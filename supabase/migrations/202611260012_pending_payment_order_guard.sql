-- Prevent concurrent M-Pesa checkout requests creating multiple pending
-- orders for the same member and service. Existing duplicates intentionally
-- make this migration fail so they can be reconciled instead of discarded.
create unique index if not exists payment_orders_one_pending_per_user_service_uidx
  on public.payment_orders(user_id, service_code)
  where status = 'PENDING';
