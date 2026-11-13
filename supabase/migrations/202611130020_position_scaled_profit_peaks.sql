-- Store each managed position's peak USD profit per unit.
-- When TP1/TP2 partially closes a position, the old peak is multiplied by
-- the remaining units, so the portfolio giveback threshold is not distorted.
alter table public.portfolio_profit_protection_state
  add column if not exists position_peak_state jsonb not null default '{}'::jsonb;

comment on column public.portfolio_profit_protection_state.position_peak_state is
'Server-only map of position ID to {peakProfitPerUnitUsd, units}. Per-unit peaks scale automatically when a TP partial close reduces remaining units.';

create or replace function public.save_portfolio_profit_protection_state_v2(
 p_user_id uuid,
 p_account_mode text,
 p_broker text,
 p_broker_account_ref text,
 p_peak_profit_usd numeric,
 p_current_profit_usd numeric,
 p_protected_floor_usd numeric,
 p_trailing_active boolean,
 p_included_position_ids text[],
 p_position_peak_state jsonb,
 p_membership_version bigint,
 p_state_version bigint,
 p_expected_state_version bigint,
 p_last_valuation_at timestamptz,
 p_quote_source text,
 p_quote_as_of timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
 v_saved boolean := false;
begin
 if p_user_id is null
    or p_account_mode is null or p_account_mode not in ('DEMO','REAL')
    or p_broker is null or p_broker not in ('DERIV','MT5')
    or nullif(trim(p_broker_account_ref),'') is null
    or p_peak_profit_usd is null or p_peak_profit_usd < 0
    or p_current_profit_usd is null
    or p_protected_floor_usd is null or p_protected_floor_usd < 0
    or p_trailing_active is null
    or p_included_position_ids is null
    or p_position_peak_state is null or jsonb_typeof(p_position_peak_state) <> 'object'
    or p_membership_version is null or p_membership_version < 0
    or p_state_version is null or p_state_version < 1
    or p_expected_state_version is null or p_expected_state_version < 0
    or p_last_valuation_at is null
    or nullif(trim(p_quote_source),'') is null
    or p_quote_as_of is null then
   raise exception 'Invalid portfolio protection state payload';
 end if;

 if array_position(p_included_position_ids, null) is not null
    or exists (select 1 from unnest(p_included_position_ids) as ids(position_id) where nullif(trim(position_id),'') is null)
    or cardinality(p_included_position_ids) <> (
      select count(distinct position_id) from unnest(p_included_position_ids) as ids(position_id)
    ) then
   raise exception 'Included position IDs must be unique and non-empty';
 end if;

 if exists (
   select 1 from jsonb_each(p_position_peak_state) as peaks(position_id, peak)
   where jsonb_typeof(peak) <> 'object'
      or not (peak ? 'peakProfitPerUnitUsd')
      or not (peak ? 'units')
      or (peak->>'peakProfitPerUnitUsd') !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?
      or (peak->>'units') !~ '^[0-9]+([.][0-9]+)?$'
      or (peak->>'units')::numeric <= 0
 ) then
   raise exception 'Invalid per-position peak state';
 end if;

 insert into public.portfolio_profit_protection_state(
   user_id, account_mode, broker, broker_account_ref,
   peak_unrealized_profit_usd, current_unrealized_profit_usd,
   protected_profit_floor_usd, trailing_active,
   included_position_ids, position_peak_state, membership_version,
   state_version, last_valuation_at, quote_source, quote_as_of, updated_at
 )
 select
   p_user_id, p_account_mode, p_broker, p_broker_account_ref,
   p_peak_profit_usd, p_current_profit_usd, p_protected_floor_usd,
   p_trailing_active, p_included_position_ids, p_position_peak_state,
   p_membership_version, p_state_version, p_last_valuation_at,
   p_quote_source, p_quote_as_of, now()
 where p_expected_state_version = 0
 on conflict (user_id, account_mode, broker, broker_account_ref)
 do update set
   peak_unrealized_profit_usd = excluded.peak_unrealized_profit_usd,
   current_unrealized_profit_usd = excluded.current_unrealized_profit_usd,
   protected_profit_floor_usd = excluded.protected_profit_floor_usd,
   trailing_active = excluded.trailing_active,
   included_position_ids = excluded.included_position_ids,
   position_peak_state = excluded.position_peak_state,
   membership_version = excluded.membership_version,
   state_version = excluded.state_version,
   last_valuation_at = excluded.last_valuation_at,
   quote_source = excluded.quote_source,
   quote_as_of = excluded.quote_as_of,
   updated_at = now()
 where public.portfolio_profit_protection_state.state_version = p_expected_state_version
 returning true into v_saved;

 return coalesce(v_saved, false);
end;
$$;

revoke all on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) to service_role;

comment on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap save for portfolio profit protection, including per-position peak-per-unit state for safe partial-close scaling.';

      or (peak->>'units') !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?
      or (peak->>'units')::numeric <= 0
 ) then
   raise exception 'Invalid per-position peak state';
 end if;

 insert into public.portfolio_profit_protection_state(
   user_id, account_mode, broker, broker_account_ref,
   peak_unrealized_profit_usd, current_unrealized_profit_usd,
   protected_profit_floor_usd, trailing_active,
   included_position_ids, position_peak_state, membership_version,
   state_version, last_valuation_at, quote_source, quote_as_of, updated_at
 )
 select
   p_user_id, p_account_mode, p_broker, p_broker_account_ref,
   p_peak_profit_usd, p_current_profit_usd, p_protected_floor_usd,
   p_trailing_active, p_included_position_ids, p_position_peak_state,
   p_membership_version, p_state_version, p_last_valuation_at,
   p_quote_source, p_quote_as_of, now()
 where p_expected_state_version = 0
 on conflict (user_id, account_mode, broker, broker_account_ref)
 do update set
   peak_unrealized_profit_usd = excluded.peak_unrealized_profit_usd,
   current_unrealized_profit_usd = excluded.current_unrealized_profit_usd,
   protected_profit_floor_usd = excluded.protected_profit_floor_usd,
   trailing_active = excluded.trailing_active,
   included_position_ids = excluded.included_position_ids,
   position_peak_state = excluded.position_peak_state,
   membership_version = excluded.membership_version,
   state_version = excluded.state_version,
   last_valuation_at = excluded.last_valuation_at,
   quote_source = excluded.quote_source,
   quote_as_of = excluded.quote_as_of,
   updated_at = now()
 where public.portfolio_profit_protection_state.state_version = p_expected_state_version
 returning true into v_saved;

 return coalesce(v_saved, false);
end;
$$;

revoke all on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) to service_role;

comment on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap save for portfolio profit protection, including per-position peak-per-unit state for safe partial-close scaling.';

      or (peak->>'units')::numeric <= 0
 ) then
   raise exception 'Invalid per-position peak state';
 end if;

 insert into public.portfolio_profit_protection_state(
   user_id, account_mode, broker, broker_account_ref,
   peak_unrealized_profit_usd, current_unrealized_profit_usd,
   protected_profit_floor_usd, trailing_active,
   included_position_ids, position_peak_state, membership_version,
   state_version, last_valuation_at, quote_source, quote_as_of, updated_at
 )
 select
   p_user_id, p_account_mode, p_broker, p_broker_account_ref,
   p_peak_profit_usd, p_current_profit_usd, p_protected_floor_usd,
   p_trailing_active, p_included_position_ids, p_position_peak_state,
   p_membership_version, p_state_version, p_last_valuation_at,
   p_quote_source, p_quote_as_of, now()
 where p_expected_state_version = 0
 on conflict (user_id, account_mode, broker, broker_account_ref)
 do update set
   peak_unrealized_profit_usd = excluded.peak_unrealized_profit_usd,
   current_unrealized_profit_usd = excluded.current_unrealized_profit_usd,
   protected_profit_floor_usd = excluded.protected_profit_floor_usd,
   trailing_active = excluded.trailing_active,
   included_position_ids = excluded.included_position_ids,
   position_peak_state = excluded.position_peak_state,
   membership_version = excluded.membership_version,
   state_version = excluded.state_version,
   last_valuation_at = excluded.last_valuation_at,
   quote_source = excluded.quote_source,
   quote_as_of = excluded.quote_as_of,
   updated_at = now()
 where public.portfolio_profit_protection_state.state_version = p_expected_state_version
 returning true into v_saved;

 return coalesce(v_saved, false);
end;
$$;

revoke all on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) to service_role;

comment on function public.save_portfolio_profit_protection_state_v2(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],jsonb,bigint,bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap save for portfolio profit protection, including per-position peak-per-unit state for safe partial-close scaling.';
