-- Traderwin security hardening for broker connection metadata.
-- Browser clients may configure bot preferences, but only trusted server-side
-- broker OAuth/verification flows may create or change connection records.
-- This prevents a client from inserting a forged external account ID or marking
-- an account as connected. Existing rows are preserved.

revoke insert, update, delete on table public.broker_connections from anon, authenticated;
grant select on table public.broker_connections to authenticated;

-- Risk acknowledgement timestamps are audit evidence, not a client-editable flag.
-- The trusted onboarding endpoint must record acknowledgement after the user
-- accepts the current risk disclosure.
revoke insert (real_risk_acknowledged_at)
  on table public.trader_profiles from authenticated;
revoke update (real_risk_acknowledged_at)
  on table public.trader_profiles from authenticated;

comment on table public.broker_connections is
  'Broker connection metadata is read-only to browser clients. Trusted server-side OAuth and verification flows own all writes.';
comment on column public.trader_profiles.real_risk_acknowledged_at is
  'Trusted-server audit timestamp recorded only after an explicit risk acknowledgement.';
