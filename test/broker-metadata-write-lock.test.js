import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("broker connection metadata is not writable by browser roles", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120013_broker_metadata_write_lock.sql", import.meta.url), "utf8");
  assert.match(sql, /revoke insert, update, delete on table public\.broker_connections from anon, authenticated/i);
  assert.match(sql, /grant select on table public\.broker_connections to authenticated/i);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update).*broker_connections.*authenticated/is);
});

test("risk acknowledgement timestamp cannot be self-asserted by browser clients", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120013_broker_metadata_write_lock.sql", import.meta.url), "utf8");
  assert.match(sql, /revoke insert \(real_risk_acknowledged_at\)[\s\S]*?from authenticated/i);
  assert.match(sql, /revoke update \(real_risk_acknowledged_at\)[\s\S]*?from authenticated/i);
});

test("broker column-level grants from the foundation migration are explicitly revoked", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120013_broker_metadata_write_lock.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("revoke insert (user_id, provider, external_account_id, account_label, account_mode)"));
  assert.ok(sql.includes("revoke update (account_label, account_mode)"));
});
