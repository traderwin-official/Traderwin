-- Compatibility bridge for databases that already had Traderwin tables before this upgrade.
-- Apply after migrations 002-011. It preserves legacy columns and existing records.
-- It does not populate a real broker account ID from a masked identifier.

-- Existing bot_settings rows use risk_per_trade_pct; the new server code reads
-- max_risk_per_trade_pct. Give legacy rows a safe UUID default and preserve their
-- configured risk, capped at the platform's 2% safety ceiling.
alter table public.bot_settings
  alter column id set default gen_random_uuid();

alter table public.bot_settings
  add column if not exists max_risk_per_trade_pct numeric(5,2) not null default 0.50;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='bot_settings'
      and column_name='risk_per_trade_pct'
  ) then
    execute $sql$
      update public.bot_settings
      set max_risk_per_trade_pct =
        least(2.00, greatest(0.01, coalesce(risk_per_trade_pct, 0.50)))
    $sql$;
  end if;
end;
$$;

comment on column public.bot_settings.max_risk_per_trade_pct is
  'Canonical platform risk setting. Backfilled from legacy risk_per_trade_pct and capped at 2%.';

-- Existing broker_connections uses broker, account_identifier_masked and
-- last_verified_at. Add canonical aliases used by the server without treating a
-- masked account identifier as a real broker account ID.
alter table public.broker_connections
  add column if not exists provider text,
  add column if not exists external_account_id text,
  add column if not exists verified_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='broker_connections'
      and column_name='broker'
  ) then
    execute $sql$
      update public.broker_connections
      set provider = coalesce(provider, upper(broker))
    $sql$;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='broker_connections'
      and column_name='last_verified_at'
  ) then
    execute $sql$
      update public.broker_connections
      set verified_at = coalesce(verified_at, last_verified_at)
    $sql$;
  end if;
end;
$$;

comment on column public.broker_connections.external_account_id is
  'Unmasked broker account identifier, written only by a trusted verified broker connection flow. Never copy account_identifier_masked into this field.';
comment on column public.broker_connections.verified_at is
  'Canonical verification timestamp; backfilled from legacy last_verified_at where available.';

-- Existing trading_signals requires pair, while the new platform uses symbol.
-- Supply UUID defaults and keep both names synchronized for old and new writers.
alter table public.trading_signals
  alter column id set default gen_random_uuid();

alter table public.trading_signals
  add column if not exists symbol text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='trading_signals'
      and column_name='pair'
  ) then
    execute $sql$
      update public.trading_signals
      set symbol = pair
      where symbol is null and pair is not null
    $sql$;
  end if;
end;
$$;

create or replace function public.traderwin_sync_signal_pair_symbol()
returns trigger
language plpgsql
set search_path = public
as $
declare
  payload jsonb;
  previous_payload jsonb;
begin
  payload := to_jsonb(new);
  previous_payload := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;

  if payload ? 'pair' and payload ? 'symbol' then
    if tg_op = 'UPDATE'
       and (payload->>'symbol') is distinct from (previous_payload->>'symbol') then
      payload := jsonb_set(payload, '{pair}', to_jsonb(payload->>'symbol'), true);
    elsif tg_op = 'UPDATE'
       and (payload->>'pair') is distinct from (previous_payload->>'pair') then
      payload := jsonb_set(payload, '{symbol}', to_jsonb(payload->>'pair'), true);
    elsif nullif(payload->>'symbol', '') is null
       and nullif(payload->>'pair', '') is not null then
      payload := jsonb_set(payload, '{symbol}', to_jsonb(payload->>'pair'), true);
    elsif nullif(payload->>'pair', '') is null
       and nullif(payload->>'symbol', '') is not null then
      payload := jsonb_set(payload, '{pair}', to_jsonb(payload->>'symbol'), true);
    end if;

    new := jsonb_populate_record(new, payload);
  end if;

  return new;
end;
$;

drop trigger if exists traderwin_sync_signal_pair_symbol on public.trading_signals;
create trigger traderwin_sync_signal_pair_symbol
before insert or update on public.trading_signals
for each row execute function public.traderwin_sync_signal_pair_symbol();

comment on column public.trading_signals.symbol is
  'Canonical platform instrument symbol. Synchronized with legacy pair for backward compatibility.';
