-- Public catalogue access with immutable client-side pricing.
-- Payment amounts must always be read by trusted server code from this table.
alter table public.service_catalog enable row level security;
drop policy if exists "Anyone reads active Traderwin services" on public.service_catalog;
create policy "Anyone reads active Traderwin services"
  on public.service_catalog for select to anon, authenticated
  using (active = true);
revoke all on public.service_catalog from anon, authenticated;
grant select on public.service_catalog to anon, authenticated;

create index if not exists payment_orders_user_created_idx
  on public.payment_orders(user_id, created_at desc);
create index if not exists payment_orders_status_created_idx
  on public.payment_orders(status, created_at desc);
create index if not exists user_subscriptions_user_status_idx
  on public.user_subscriptions(user_id, status);
create index if not exists course_enrolments_user_status_idx
  on public.course_enrolments(user_id, status);

comment on table public.service_catalog is
  'Public read-only service catalogue. Only trusted server-side operations may change prices or active status.';
