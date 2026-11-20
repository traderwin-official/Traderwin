-- Server-managed allowlist for instruments that may be used by Young Tiger FX.
-- Deriv active-symbol discovery is informational only and never writes to this registry.
create table if not exists public.trading_instrument_approvals (
  id uuid primary key default gen_random_uuid(),
  broker text not null check (broker in ('DERIV','MT5')),
  instrument text not null check (instrument ~ '^[A-Za-z0-9_]{2,30}$'),
  provider text not null check (provider in ('DERIV','MT5')),
  provider_symbol text not null check (provider_symbol ~ '^[A-Za-z0-9_]{2,40}$'),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','DISABLED')),
  is_active boolean not null default false,
  approval_note text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (broker,instrument),
  unique (broker,provider_symbol),
  check (
    (status='APPROVED' and is_active=true and approved_at is not null)
    or status<>'APPROVED'
  ),
  check (status<>'APPROVED' or approved_by is not null)
);
comment on table public.trading_instrument_approvals is
  'Server-managed trading allowlist. Provider discovery never inserts or approves rows. Empty registry means all instruments are denied.';
comment on column public.trading_instrument_approvals.provider_symbol is
  'Exact server-side provider contract symbol. Must match the live feed adapter response; never inferred from browser input.';
comment on column public.trading_instrument_approvals.status is
  'PENDING and DISABLED are denied. Only APPROVED plus is_active=true is eligible for subsequent server-side checks.';

create table if not exists public.trading_instrument_approval_audit (
  id bigint generated always as identity primary key,
  approval_id uuid,
  broker text not null,
  instrument text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  old_record jsonb,
  new_record jsonb,
  actor_user_id uuid,
  actor_role text,
  occurred_at timestamptz not null default now()
);
comment on table public.trading_instrument_approval_audit is
  'Append-only audit trail for server-managed instrument approval changes.';

create or replace function public.audit_trading_instrument_approval()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_id uuid;
  v_broker text;
  v_instrument text;
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op='INSERT' then
    v_id:=new.id; v_broker:=new.broker; v_instrument:=new.instrument;
    v_new:=to_jsonb(new);
  elsif tg_op='UPDATE' then
    v_id:=new.id; v_broker:=new.broker; v_instrument:=new.instrument;
    v_old:=to_jsonb(old); v_new:=to_jsonb(new);
  else
    v_id:=old.id; v_broker:=old.broker; v_instrument:=old.instrument;
    v_old:=to_jsonb(old);
  end if;

  insert into public.trading_instrument_approval_audit
    (approval_id,broker,instrument,operation,old_record,new_record,actor_user_id,actor_role)
  values (v_id,v_broker,v_instrument,tg_op,v_old,v_new,auth.uid(),coalesce(auth.role(),'unknown'));

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trading_instrument_approval_audit_trigger
  on public.trading_instrument_approvals;
create trigger trading_instrument_approval_audit_trigger
  after insert or update or delete on public.trading_instrument_approvals
  for each row execute function public.audit_trading_instrument_approval();

alter table public.trading_instrument_approvals enable row level security;
alter table public.trading_instrument_approval_audit enable row level security;
revoke all on public.trading_instrument_approvals,public.trading_instrument_approval_audit
  from public,anon,authenticated;
grant select,insert,update,delete on public.trading_instrument_approvals to service_role;
grant select,insert on public.trading_instrument_approval_audit to service_role;
grant usage,select on sequence public.trading_instrument_approval_audit_id_seq to service_role;
