-- Young Tiger FX: verified Deriv OAuth account metadata.
-- Safe to rerun; preserves existing encrypted tokens and user records.

alter table public.deriv_connections
  add column if not exists token_expires_at timestamptz,
  add column if not exists token_type text,
  add column if not exists requested_scopes jsonb not null default '[]'::jsonb,
  add column if not exists accounts jsonb not null default '[]'::jsonb,
  add column if not exists connected_at timestamptz;

comment on column public.deriv_connections.accounts is
  'Sanitized account identifiers and account types returned by Deriv. No balances or access tokens are exposed to browser clients.';
comment on column public.deriv_connections.token_expires_at is
  'Expiry timestamp derived from Deriv OAuth expires_in; reauthorization is required after expiry because Deriv does not issue refresh tokens.';
