import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy Traderwin schema compatibility preserves required columns and adds safe defaults", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120012_legacy_schema_compatibility.sql", import.meta.url), "utf8");
  assert.match(sql, /alter column id set default gen_random_uuid\(\)/i);
  assert.match(sql, /max_risk_per_trade_pct/i);
  assert.match(sql, /risk_per_trade_pct/i);
  assert.match(sql, /add column if not exists provider text/i);
  assert.match(sql, /add column if not exists external_account_id text/i);
  assert.match(sql, /last_verified_at/i);
  assert.match(sql, /alter column id set default gen_random_uuid\(\)/ig);
  assert.match(sql, /traderwin_sync_signal_pair_symbol/i);
  assert.match(sql, /jsonb_populate_record/i);
  assert.match(sql, /Never copy account_identifier_masked/i);
});

test("legacy masked broker account IDs are never promoted to executable account IDs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120012_legacy_schema_compatibility.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /set\s+external_account_id\s*=\s*account_identifier_masked/i);
});
