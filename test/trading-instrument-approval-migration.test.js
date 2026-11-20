import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/202611200006_trading_instrument_approval_registry.sql", import.meta.url),
  "utf8"
);

test("instrument approval migration has balanced PL/pgSQL delimiters", () => {
  assert.equal((migration.match(/\bas \$\$/g) || []).length, 1);
  assert.equal((migration.match(/\n\$\$;/g) || []).length, 1);
  assert.equal(/\bas \$(?!\$)|\n\$;(?!\$)/.test(migration), false);
});

test("registry is deny-by-default and requires explicit approval metadata", () => {
  assert.match(migration, /status text not null default 'PENDING'/);
  assert.match(migration, /is_active boolean not null default false/);
  assert.match(migration, /status='APPROVED' and is_active=true and approved_at is not null/);
  assert.match(migration, /status<>'APPROVED' or approved_by is not null/);
  assert.match(migration, /updated_by uuid references auth\.users\(id\)/);
  assert.match(migration, /unique \(broker,instrument\)/);
  assert.match(migration, /unique \(broker,provider_symbol\)/);
});

test("approval and audit data are private to server role", () => {
  assert.match(migration, /alter table public\.trading_instrument_approvals enable row level security/);
  assert.match(migration, /alter table public\.trading_instrument_approval_audit enable row level security/);
  assert.match(migration, /revoke all on public\.trading_instrument_approvals,public\.trading_instrument_approval_audit\s+from public,anon,authenticated/);
  assert.match(migration, /grant select,insert,update,delete on public\.trading_instrument_approvals to service_role/);
  assert.match(migration, /grant select,insert on public\.trading_instrument_approval_audit to service_role/);
});

test("every registry mutation is recorded in an audit event", () => {
  assert.match(migration, /after insert or update or delete on public\.trading_instrument_approvals/);
  assert.match(migration, /insert into public\.trading_instrument_approval_audit/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /auth\.role\(\)/);
  assert.match(migration, /v_actor:=coalesce\(auth\.uid\(\),new\.updated_by/);
  assert.doesNotMatch(migration, /\b(drop table|drop column|truncate)\b/i);
});
