import test from "node:test";
import assert from "node:assert/strict";
import {resolveDemoAutoStrategy} from "../lib/demo-session-mode.js";

test("keeps MANUAL sessions manual unless explicit DEMO paper opt-in is enabled",()=>{
 const base={status:"RUNNING",strategy:"MANUAL",config_snapshot:{account_mode:"DEMO",execution:"WEBSITE_PAPER_ONLY",auto_strategy:"MULTI_CONFIRMATION_V1"}};
 assert.equal(resolveDemoAutoStrategy(base),null);
 assert.equal(resolveDemoAutoStrategy({...base,config_snapshot:{...base.config_snapshot,auto_trading_enabled:true}}),"MULTI_CONFIRMATION_V1");
});

test("rejects REAL, non-paper, and unapproved automatic strategies",()=>{
 const base={status:"RUNNING",strategy:"MANUAL",config_snapshot:{account_mode:"REAL",execution:"WEBSITE_PAPER_ONLY",auto_trading_enabled:true,auto_strategy:"MULTI_CONFIRMATION_V1"}};
 assert.equal(resolveDemoAutoStrategy(base),null);
 assert.equal(resolveDemoAutoStrategy({...base,config_snapshot:{...base.config_snapshot,account_mode:"DEMO",execution:"BROKER",auto_strategy:"MULTI_CONFIRMATION_V1"}}),null);
 assert.equal(resolveDemoAutoStrategy({...base,config_snapshot:{...base.config_snapshot,account_mode:"DEMO",execution:"WEBSITE_PAPER_ONLY",auto_strategy:"UNAPPROVED"}}),null);
});

test("continues to accept existing validated automatic session strategies",()=>{
 assert.equal(resolveDemoAutoStrategy({status:"RUNNING",strategy:"AUTO_SELECT_V1"}),"AUTO_SELECT_V1");
 assert.equal(resolveDemoAutoStrategy({status:"STOPPED",strategy:"AUTO_SELECT_V1"}),null);
});
