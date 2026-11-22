import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Deriv proposal route is authenticated, verified-DEMO scoped and read-only", async () => {
  const route = await readFile(new URL("../api/deriv/proposal.js", import.meta.url), "utf8");
  const websocket = await readFile(new URL("../lib/deriv/proposal-session-websocket.js", import.meta.url), "utf8");
  assert.match(route, /auth\.getUser/);
  assert.match(route, /encrypted_access_token/);
  assert.match(route, /demo_account_id/);
  assert.match(route, /normalizeVerifiedDerivAccounts/);
  assert.match(route, /account_type === "demo"/);
  assert.match(route, /\/trading\/v1\/options\/accounts/);
  assert.match(route, /\/otp/);
  assert.match(route, /ws\/demo/);
  assert.match(route, /normalizeDerivContractsForResponse/);
  assert.match(route, /buildDerivProposalRequest/);
  assert.match(route, /normalizeDerivProposalResponse/);
  assert.match(route, /proposal_kind: "ONE_TIME_READ_ONLY"/);
  assert.match(route, /proposal_usable_for_buy: false/);
  assert.match(route, /sizing_authorized: false/);
  assert.match(route, /execution_authorized: false/);
  assert.match(route, /real_trading_enabled: false/);
  assert.doesNotMatch(route + websocket, /buy: 1|sell: 1/);
  assert.match(websocket, /contracts_for: symbol/);
  assert.match(websocket, /socket\.send\(JSON\.stringify\(proposalRequest\)\)/);
});
