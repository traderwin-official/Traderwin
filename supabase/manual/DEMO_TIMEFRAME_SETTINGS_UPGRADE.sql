-- Add the selected timeframe field required by automated website DEMO settings.
-- Safe to run once or repeatedly. Existing bot settings and risk limits are preserved.
begin;

do $$ begin
  if to_regclass('public.bot_settings') is null then
    raise exception 'Prerequisite missing: public.bot_settings';
  end if;
end $$;

alter table public.bot_settings
  add column if not exists timeframe text not null default 'M15';

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bot_settings'::regclass
       and conname = 'bot_settings_timeframe_check'
  ) then
    alter table public.bot_settings
      add constraint bot_settings_timeframe_check
      check (timeframe in ('M5','M15','H1','H4'));
  end if;
end $$;

grant insert(user_id,broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;
grant update(broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe)
  on public.bot_settings to authenticated;

commit;
