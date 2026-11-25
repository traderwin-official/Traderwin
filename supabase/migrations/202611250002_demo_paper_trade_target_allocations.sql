-- Restore the target-allocation columns required by the DEMO positions API,
-- manual bracket worker, and pending-batch activation RPC.
-- Existing rows intentionally remain NULL: no historical allocation is inferred.
alter table public.demo_paper_trades
  add column if not exists tp1_percent numeric(5,2),
  add column if not exists tp2_percent numeric(5,2),
  add column if not exists tp3_percent numeric(5,2);

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.demo_paper_trades'::regclass
      and conname = 'demo_paper_trades_target_percentages_valid'
  ) then
    alter table public.demo_paper_trades
      add constraint demo_paper_trades_target_percentages_valid
      check (
        (tp1_percent is null and tp2_percent is null and tp3_percent is null)
        or
        (
          tp1_percent is not null and tp2_percent is not null and tp3_percent is not null
          and tp1_percent > 0 and tp1_percent <= 100
          and tp2_percent > 0 and tp2_percent <= 100
          and tp3_percent > 0 and tp3_percent <= 100
          and round(tp1_percent + tp2_percent + tp3_percent, 2) = 100
        )
      );
  end if;
end
$constraints$;