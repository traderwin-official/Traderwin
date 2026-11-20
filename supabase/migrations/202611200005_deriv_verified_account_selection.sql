-- Additive Deriv OAuth metadata required by the authenticated account picker.
-- Existing encrypted tokens and account identifiers are preserved.
alter table public.deriv_connections
  add column if not exists accounts jsonb not null default '[]'::jsonb,
  add column if not exists token_type text,
  add column if not exists requested_scopes jsonb not null default '[]'::jsonb,
  add column if not exists connected_at timestamptz;

comment on column public.deriv_connections.accounts is
  'Sanitized, active Deriv account identifiers and types verified by the server. Never contains OAuth access tokens or balances.';
comment on column public.deriv_connections.requested_scopes is
  'OAuth scopes requested by Tiger Scheme; trading authorization is not live-trading approval.';
comment on column public.deriv_connections.connected_at is
  'Timestamp when the server completed Deriv OAuth token and account verification.';
