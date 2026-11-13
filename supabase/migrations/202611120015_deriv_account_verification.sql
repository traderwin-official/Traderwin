-- Store verified Deriv demo/real account identifiers and OAuth expiry.
alter table public.deriv_connections
  add column if not exists demo_account_id text,
  add column if not exists real_account_id text,
  add column if not exists token_expires_at timestamptz;

comment on column public.deriv_connections.demo_account_id is
  'Verified Deriv demo account ID returned by GET /trading/v1/options/accounts.';
comment on column public.deriv_connections.real_account_id is
  'Verified Deriv real account ID returned by GET /trading/v1/options/accounts. Live execution remains separately locked.';
comment on column public.deriv_connections.token_expires_at is
  'OAuth access-token expiry calculated from the provider expires_in value.';
