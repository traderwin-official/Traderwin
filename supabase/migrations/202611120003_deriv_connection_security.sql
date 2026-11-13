-- Secure storage for Deriv OAuth credentials. Run after the platform foundation migration.
-- Browser roles receive no privileges on this table; only trusted server functions use service role.
create table if not exists public.deriv_connections(
 user_id uuid primary key references auth.users(id) on delete cascade,
 deriv_account_id text,
 encrypted_access_token text not null,
 updated_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);
alter table public.deriv_connections add column if not exists deriv_account_id text;
alter table public.deriv_connections add column if not exists encrypted_access_token text;
alter table public.deriv_connections add column if not exists updated_at timestamptz not null default now();
alter table public.deriv_connections add column if not exists created_at timestamptz not null default now();
alter table public.deriv_connections enable row level security;
revoke all on public.deriv_connections from anon,authenticated;
comment on table public.deriv_connections is 'Contains encrypted Deriv OAuth tokens. Access only from trusted server-side code using service role.';
