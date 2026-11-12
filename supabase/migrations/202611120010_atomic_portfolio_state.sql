-- Atomic compare-and-swap persistence for portfolio monitoring.
-- Apply only after migrations 008 and 009 have been reviewed and applied.
alter table public.portfolio_profit_protection_state
 add column if not exists quote_source text,
 add column if not exists quote_as_of timestamptz;

alter table public.portfolio_trade_permissions
 add column if not exists bot_trade_management boolean not null default false,
 add column if not exists close_managed_positions boolean not null default false;

create or replace function public.save_portfolio_profit_protection_state(
 p_user_id uuid,
 p_account_mode text,
 p_broker text,
 p_broker_account_ref text,
 p_peak_profit_usd numeric,
 p_current_profit_usd numeric,
 p_protected_floor_usd numeric,
 p_trailing_active boolean,
 p_included_position_ids text[],
 p_membership_version bigint,
 p_expected_membership_version bigint,
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
    or p_account_mode not in ('DEMO','REAL')
    or p_broker not in ('DERIV','MT5')
    or nullif(trim(p_broker_account_ref),'') is null
    or p_peak_profit_usd is null or p_peak_profit_usd < 0
    or p_current_profit_usd is null
    or p_protected_floor_usd is null or p_protected_floor_usd < 0
    or p_trailing_active is null
    or p_included_position_ids is null
    or p_membership_version is null or p_membership_version < 0
    or p_expected_membership_version is null or p_expected_membership_version < 0
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

 insert into public.portfolio_profit_protection_state(
   user_id, account_mode, broker, broker_account_ref,
   peak_unrealized_profit_usd, current_unrealized_profit_usd,
   protected_profit_floor_usd, trailing_active,
   included_position_ids, membership_version,
   last_valuation_at, quote_source, quote_as_of, updated_at
 )
 select
   p_user_id, p_account_mode, p_broker, p_broker_account_ref,
   p_peak_profit_usd, p_current_profit_usd,
   p_protected_floor_usd, p_trailing_active,
   p_included_position_ids, p_membership_version,
   p_last_valuation_at, p_quote_source, p_quote_as_of, now()
 where p_expected_membership_version = 0
 on conflict (user_id, account_mode, broker, broker_account_ref)
 do update set
   peak_unrealized_profit_usd = excluded.peak_unrealized_profit_usd,
   current_unrealized_profit_usd = excluded.current_unrealized_profit_usd,
   protected_profit_floor_usd = excluded.protected_profit_floor_usd,
   trailing_active = excluded.trailing_active,
   included_position_ids = excluded.included_position_ids,
   membership_version = excluded.membership_version,
   last_valuation_at = excluded.last_valuation_at,
   quote_source = excluded.quote_source,
   quote_as_of = excluded.quote_as_of,
   updated_at = now()
 where public.portfolio_profit_protection_state.membership_version = p_expected_membership_version
 returning true into v_saved;

 return coalesce(v_saved, false);
end;
$$;

revoke all on function public.save_portfolio_profit_protection_state(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],bigint,bigint,timestamptz,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.save_portfolio_profit_protection_state(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],bigint,bigint,timestamptz,text,timestamptz
) to service_role;

comment on column public.portfolio_trade_permissions.bot_trade_management is 'Explicit per-account permission for Traderwin to manage positions opened by its bot.';
comment on column public.portfolio_trade_permissions.close_managed_positions is 'Explicit per-account permission to close positions included in profit protection. Monitoring-only never grants this permission.';

comment on function public.save_portfolio_profit_protection_state(
 uuid,text,text,text,numeric,numeric,numeric,boolean,text[],bigint,bigint,timestamptz,text,timestamptz
) is 'Service-role-only atomic compare-and-swap persistence for one user, broker account and account mode. Returns false on version conflict.';
