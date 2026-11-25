-- Portfolio-level trailing protection and explicit manual-position management permission.
-- This migration creates server-side state only; it does not connect to brokers or close trades.
create table if not exists public.portfolio_trade_permissions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 account_mode text not null check(account_mode in('DEMO','REAL')),
 broker text not null check(broker in('DERIV','MT5')),
 broker_account_ref text not null,
 manual_trade_management boolean not null default false,
 permission_granted_at timestamptz,
 permission_revoked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,account_mode,broker,broker_account_ref),
 check((manual_trade_management and permission_granted_at is not null and permission_revoked_at is null)
    or (not manual_trade_management))
);
alter table public.portfolio_trade_permissions enable row level security;
revoke all on public.portfolio_trade_permissions from anon,authenticated;
comment on table public.portfolio_trade_permissions is 'Server-controlled per-account permissions. Manual positions are excluded unless the owner explicitly opts into management. Monitoring alone never grants close authority.';

create table if not exists public.portfolio_profit_protection_state (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 account_mode text not null check(account_mode in('DEMO','REAL')),
 broker text not null check(broker in('DERIV','MT5')),
 broker_account_ref text not null,
 profit_currency text not null default 'USD' check(profit_currency='USD'),
 peak_unrealized_profit_usd numeric(18,6) not null default 0 check(peak_unrealized_profit_usd>=0),
 current_unrealized_profit_usd numeric(18,6) not null default 0,
 protected_profit_floor_usd numeric(18,6) not null default 0,
 activation_threshold_usd numeric(18,6) not null default 20 check(activation_threshold_usd>0),
 giveback_pct numeric(5,2) not null default 20 check(giveback_pct>0 and giveback_pct<=50),
 trailing_active boolean not null default false,
 last_valuation_at timestamptz,
 updated_at timestamptz not null default now(),
 unique(user_id,account_mode,broker,broker_account_ref)
);
alter table public.portfolio_profit_protection_state enable row level security;
revoke all on public.portfolio_profit_protection_state from anon,authenticated;
comment on table public.portfolio_profit_protection_state is 'Server-only combined open-position P&L peak. DEMO and REAL and each broker account have separate records. Values are normalized to USD by a verified server-side valuation adapter.';
