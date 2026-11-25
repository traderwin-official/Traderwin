import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("scalping preference endpoint is authenticated, verified DEMO-only and bounded",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/scalping-preferences.js",import.meta.url),"utf8");
 assert.match(s,/auth\.getUser/);
 assert.match(s,/profile\.account_mode!==\"DEMO\"/);
 assert.match(s,/broker_account_ref.*accountRef/);
 assert.match(s,/execution:\"WEBSITE_PAPER_ONLY\"/);
 assert.match(s,/max_risk_per_trade_pct:risk/);
 assert.match(s,/Math\.min\(Number\(profile\.max_risk_per_trade_pct\),0\.25\)/);
 assert.match(s,/demo_account_id/);
 assert.match(s,/account_type.*demo/);
 assert.match(s,/status.*active/);
 assert.match(s,/trading_instrument_approvals/);
 assert.match(s,/session\.config_snapshot/);
 assert.match(s,/WEBSITE_DEMO_AUTO_PAPER_ONLY/);
 assert.match(s,/action===\"DISABLE\"/);
 assert.match(s,/ENABLE_PAPER_EXECUTION/);
 assert.match(s,/DISABLE_PAPER_EXECUTION/);
 assert.match(s,/paper_execution_enabled/);
 assert.match(s,/paperExecutionEnabled/);
 assert.doesNotMatch(s,/real_trading_enabled:\s*true|account_mode:\s*\"REAL\"/);
});
