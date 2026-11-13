-- Persist the exact managed-position membership used to calculate each portfolio peak.
-- A change in membership (for example, revoking manual-trade management) requires a fresh peak baseline.
alter table public.portfolio_profit_protection_state
 add column if not exists included_position_ids text[] not null default '{}',
 add column if not exists membership_version bigint not null default 0 check(membership_version>=0);

comment on column public.portfolio_profit_protection_state.included_position_ids is
 'Sorted broker position identifiers included in the last portfolio valuation. Reset the peak baseline whenever this set changes.';
comment on column public.portfolio_profit_protection_state.membership_version is
 'Incremented atomically by the server-side valuation worker whenever included position membership changes.';
