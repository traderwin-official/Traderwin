const REQUIRED_TABLES = [
  "scalping_market_ticks",
  "demo_scalping_preferences",
  "scalping_worker_leases",
  "demo_paper_sessions",
  "demo_paper_trades",
  "trader_profiles",
  "trading_instrument_approvals"
];
const REQUIRED_RPCS = [
  "claim_traderwin_scalping_worker",
  "release_traderwin_scalping_worker",
  "open_demo_scalping_paper_trade_with_lease",
  "mark_demo_scalping_paper_trade_with_lease",
  "manage_demo_scalping_paper_exit_with_lease"
];

const jsonHeaders = key => ({
  apikey: key,
  authorization: "Bearer " + key,
  accept: "application/json"
});

export async function checkScalpingRuntimeReadiness({
  url, serviceRoleKey, fetchImpl = globalThis.fetch
}) {
  const failures = [];
  const checks = { api: false, tables: [], rpcs: [], approvedDerivInstruments: [] };
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    return { ready: false, checks, failures: ["SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and fetch are required."] };
  }

  let base;
  try {
    base = new URL(url);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
      throw new Error("Supabase URL must use HTTPS.");
    }
  } catch (error) {
    return { ready: false, checks, failures: [error.message || "Invalid SUPABASE_URL."] };
  }

  const rest = new URL("/rest/v1/", base).toString();
  let schema;
  try {
    const response = await fetchImpl(rest, { headers: { ...jsonHeaders(serviceRoleKey), accept: "application/openapi+json" } });
    if (!response.ok) throw new Error("Supabase REST schema check returned HTTP " + response.status + ".");
    schema = await response.json();
    checks.api = true;
  } catch (error) {
    return { ready: false, checks, failures: [error.message || "Supabase REST API is unavailable."] };
  }

  const paths = schema?.paths || {};
  for (const table of REQUIRED_TABLES) {
    if (!paths["/" + table]) {
      failures.push("Required table is missing or not exposed: " + table);
      continue;
    }
    try {
      const endpoint = new URL(table, rest);
      endpoint.searchParams.set("select", "*");
      endpoint.searchParams.set("limit", "0");
      const response = await fetchImpl(endpoint, { headers: jsonHeaders(serviceRoleKey) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      checks.tables.push(table);
    } catch (error) {
      failures.push("Table check failed for " + table + ": " + (error.message || "unknown error"));
    }
  }

  for (const rpc of REQUIRED_RPCS) {
    if (!paths["/rpc/" + rpc]) failures.push("Required service RPC is missing or unavailable: " + rpc);
    else checks.rpcs.push(rpc);
  }

  if (paths["/trading_instrument_approvals"]) {
    try {
      const endpoint = new URL("trading_instrument_approvals", rest);
      endpoint.searchParams.set("select", "broker,instrument,provider,provider_symbol,status,is_active,approved_at,approved_by");
      endpoint.searchParams.set("broker", "eq.DERIV");
      endpoint.searchParams.set("provider", "eq.DERIV");
      endpoint.searchParams.set("status", "eq.APPROVED");
      endpoint.searchParams.set("is_active", "eq.true");
      endpoint.searchParams.set("limit", "100");
      const response = await fetchImpl(endpoint, { headers: jsonHeaders(serviceRoleKey) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const rows = await response.json();
      checks.approvedDerivInstruments = (Array.isArray(rows) ? rows : [])
        .filter(row => row.approved_at && row.approved_by && row.instrument && row.provider_symbol)
        .map(row => ({ instrument: row.instrument, providerSymbol: row.provider_symbol }));
      if (!checks.approvedDerivInstruments.length) {
        failures.push("No explicitly approved active DERIV instruments were found. Do not auto-approve provider discoveries.");
      }
    } catch (error) {
      failures.push("Approved-instrument check failed: " + (error.message || "unknown error"));
    }
  }

  return { ready: failures.length === 0, checks, failures };
}

if (import.meta.url === new URL(process.argv[1] || "", "file:").href) {
  const result = await checkScalpingRuntimeReadiness({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}
