import test from "node:test";
import assert from "node:assert/strict";
import { checkScalpingRuntimeReadiness } from "../scripts/check-scalping-runtime-readiness.js";

const tables = [
  "scalping_market_ticks","scalping_signal_events","demo_scalping_preferences","scalping_worker_leases",
  "demo_paper_sessions","demo_paper_trades","trader_profiles","trading_instrument_approvals"
];
const rpcs = [
  "claim_traderwin_scalping_worker","release_traderwin_scalping_worker",
  "open_demo_scalping_paper_trade_with_lease","mark_demo_scalping_paper_trade_with_lease",
  "manage_demo_scalping_paper_exit_with_lease"
];
const schema = { paths: Object.fromEntries([
  ...tables.map(name => ["/"+name, {}]),
  ...rpcs.map(name => ["/rpc/"+name, {}])
]) };
const response = (body, status=200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

test("runtime readiness passes only when all required tables, RPCs and approved Deriv instruments exist", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/rest/v1/")) return response(schema);
    if (String(url).includes("trading_instrument_approvals?")) return response([{
      broker:"DERIV",instrument:"EURUSD",provider:"DERIV",provider_symbol:"frxEURUSD",
      status:"APPROVED",is_active:true,approved_at:"2026-11-26T00:00:00Z",approved_by:"admin"
    }]);
    return response([]);
  };
  const result = await checkScalpingRuntimeReadiness({
    url:"https://example.supabase.co",serviceRoleKey:"service-role-secret",fetchImpl
  });
  assert.equal(result.ready,true);
  assert.deepEqual(result.checks.tables,tables);
  assert.deepEqual(result.checks.rpcs,rpcs);
  assert.deepEqual(result.checks.approvedDerivInstruments,[{instrument:"EURUSD",providerSymbol:"frxEURUSD"}]);
  assert.ok(calls.every(call => call.options.headers.authorization === "Bearer service-role-secret"));
});

test("runtime readiness fails closed when worker migrations are missing", async () => {
  const fetchImpl = async url => String(url).endsWith("/rest/v1/") ? response({paths:{}}) : response([]);
  const result = await checkScalpingRuntimeReadiness({
    url:"https://example.supabase.co",serviceRoleKey:"service-role-secret",fetchImpl
  });
  assert.equal(result.ready,false);
  assert.ok(result.failures.some(reason => reason.includes("scalping_worker_leases")));
  assert.ok(result.failures.some(reason => reason.includes("open_demo_scalping_paper_trade_with_lease")));
});

test("runtime readiness fails closed when there are no explicitly approved instruments", async () => {
  const fetchImpl = async url => {
    if (String(url).endsWith("/rest/v1/")) return response(schema);
    return response([]);
  };
  const result = await checkScalpingRuntimeReadiness({
    url:"https://example.supabase.co",serviceRoleKey:"service-role-secret",fetchImpl
  });
  assert.equal(result.ready,false);
  assert.ok(result.failures.some(reason => reason.includes("No explicitly approved active DERIV instruments")));
});

test("runtime readiness rejects insecure remote Supabase URLs without making requests", async () => {
  let called = false;
  const result = await checkScalpingRuntimeReadiness({
    url:"http://example.supabase.co",serviceRoleKey:"service-role-secret",
    fetchImpl:async()=>{called=true;return response(schema);}
  });
  assert.equal(result.ready,false);
  assert.equal(called,false);
});
