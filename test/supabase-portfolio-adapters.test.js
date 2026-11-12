import test from "node:test";
import assert from "node:assert/strict";
import { createSupabasePortfolioAdapters } from "../lib/supabase-portfolio-adapters.js";

function fakeDb({ rows = {}, rpcResult = true } = {}) {
  const calls = { rpc: [], filters: [] };
  return {
    calls,
    from(table) {
      const query = {
        select(columns) { calls.filters.push({ table, columns }); return this; },
        eq(column, value) { calls.filters.push({ table, column, value }); return this; },
        async maybeSingle() { return { data: rows[table] ?? null, error: null }; }
      };
      return query;
    },
    async rpc(name, args) { calls.rpc.push({ name, args }); return { data: rpcResult, error: null }; }
  };
}

const scope = { userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "acc-1" };

test("Supabase state adapter maps database columns and returns safe initial state", async () => {
  const db = fakeDb({ rows: { portfolio_profit_protection_state: {
    peak_unrealized_profit_usd: "125.50",
    included_position_ids: ["a", "b"],
    membership_version: 3,
    state_version: 11
  } } });
  const adapter = createSupabasePortfolioAdapters(db);
  assert.deepEqual(await adapter.loadState(scope), {
    peakProfitUsd: 125.5, includedPositionIds: ["a", "b"], membershipVersion: 3, stateVersion: 11
  });

  const empty = createSupabasePortfolioAdapters(fakeDb());
  assert.deepEqual(await empty.loadState(scope), {
    peakProfitUsd: 0, includedPositionIds: [], membershipVersion: 0, stateVersion: 0
  });
});

test("missing account permission row grants no management or closing authority", async () => {
  const adapter = createSupabasePortfolioAdapters(fakeDb());
  assert.deepEqual(await adapter.loadPermissions(scope), {
    manageManualTrades: false, manageBotTrades: false, closeManagedPositions: false
  });
});

test("permission values are mapped only from explicit true database flags", async () => {
  const db = fakeDb({ rows: { portfolio_trade_permissions: {
    manual_trade_management: true,
    bot_trade_management: true,
    close_managed_positions: false
  } } });
  const adapter = createSupabasePortfolioAdapters(db);
  assert.deepEqual(await adapter.loadPermissions(scope), {
    manageManualTrades: true, manageBotTrades: true, closeManagedPositions: false
  });
});

test("state save calls atomic RPC with distinct state and membership versions", async () => {
  const db = fakeDb({ rpcResult: true });
  const adapter = createSupabasePortfolioAdapters(db);
  const state = {
    peakProfitUsd: 100, currentProfitUsd: 80, protectedFloorUsd: 80,
    trailingActive: true, includedPositionIds: ["p1"], membershipVersion: 5,
    stateVersion: 12, lastValuationAt: "2026-11-12T10:00:00.000Z",
    quoteSource: "Deriv public ticks", quoteAsOf: "2026-11-12T09:59:59.000Z"
  };
  const result = await adapter.saveState(scope, state, 11);
  assert.deepEqual(result, { saved: true });
  assert.equal(db.calls.rpc[0].name, "save_portfolio_profit_protection_state");
  assert.equal(db.calls.rpc[0].args.p_state_version, 12);
  assert.equal(db.calls.rpc[0].args.p_expected_state_version, 11);
  assert.equal(db.calls.rpc[0].args.p_membership_version, 5);
});

test("REAL authorization requires all server-side approval timestamps", async () => {
  const realScope = { ...scope, accountMode: "REAL" };
  const incomplete = createSupabasePortfolioAdapters(fakeDb({ rows: {
    real_execution_authorizations: {
      status: "AUTHORIZED", authorized_at: "2026-11-12T10:00:00Z",
      broker_verified_at: null, risk_acknowledged_at: "2026-11-12T10:00:00Z"
    }
  } }));
  assert.equal(await incomplete.isRealExecutionAuthorized(realScope), false);

  const complete = createSupabasePortfolioAdapters(fakeDb({ rows: {
    real_execution_authorizations: {
      status: "AUTHORIZED", authorized_at: "2026-11-12T10:00:00Z",
      broker_verified_at: "2026-11-12T10:00:00Z", risk_acknowledged_at: "2026-11-12T10:00:00Z"
    }
  } }));
  assert.equal(await complete.isRealExecutionAuthorized(realScope), true);
});
