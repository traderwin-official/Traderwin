import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ledger = readFileSync(new URL("../supabase/migrations/202611200001_demo_paper_ledger_v2.sql", import.meta.url), "utf8");
const portfolio = readFileSync(new URL("../supabase/migrations/202611200002_portfolio_protection_state_v2.sql", import.meta.url), "utf8");

test("DEMO ledger migration has balanced PL/pgSQL function delimiters", () => {
  assert.equal((ledger.match(/\bas \$\$/g) || []).length, 6);
  assert.equal((ledger.match(/end \$\$;/g) || []).length, 6);
  assert.equal(/\bas \$(?!\$)|end \$(?!\$);/.test(ledger), false);
});

test("portfolio persistence migration matches the Supabase adapter contract", () => {
  for (const field of [
    "included_position_ids", "position_peak_state", "membership_version",
    "state_version", "close_manual_trades"
  ]) assert.match(portfolio, new RegExp(field));
  assert.match(portfolio, /save_portfolio_profit_protection_state_v2/);
  assert.match(portfolio, /p_position_peak_state jsonb/);
  assert.match(portfolio, /where public\.portfolio_profit_protection_state\.state_version = p_expected_state_version/);
  assert.equal(/\bas \$(?!\$)|end \$(?!\$);/.test(portfolio), false);
  assert.doesNotMatch(portfolio, /\b(drop table|drop column|truncate)\b/i);
});

test("manual monitoring and manual closing remain separate database permissions", () => {
  assert.match(portfolio, /manual_trade_management boolean not null default false/);
  assert.match(portfolio, /close_manual_trades boolean not null default false/);
  assert.match(portfolio, /Separate explicit permission to close manual positions/);
});

test("DEMO BOT portfolio protection defaults on while manual management defaults off", () => {
  assert.match(portfolio, /bot_trade_management boolean not null default true/);
  assert.match(portfolio, /close_managed_positions boolean not null default true/);
  assert.match(portfolio, /manual_trade_management boolean not null default false/);
  assert.match(portfolio, /close_manual_trades boolean not null default false/);
});
