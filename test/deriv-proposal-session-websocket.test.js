import test from "node:test";
import assert from "node:assert/strict";
import { fetchDerivProposalSession } from "../lib/deriv/proposal-session-websocket.js";

class FakeProposalSocket extends EventTarget {
  constructor(url, failAt = null) {
    super();
    this.url = url;
    this.failAt = failAt;
    this.sent = [];
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    queueMicrotask(() => {
      let payload;
      if (this.failAt === request.req_id) {
        payload = { req_id: request.req_id, error: { code: "InvalidContract" } };
      } else if (request.req_id === 8300) {
        payload = {
          req_id: 8300, msg_type: "contracts_for",
          echo_req: { contracts_for: "R_50" },
          contracts_for: { available: [{ contract_type: "CALL" }] }
        };
      } else {
        payload = {
          req_id: 8301, msg_type: "proposal",
          echo_req: { ...request },
          proposal: { id: "private-proposal-id" }
        };
      }
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    });
  }
  close() { this.dispatchEvent(new Event("close")); }
}

test("requests catalogue first, then only a proposal on the account-scoped session", async () => {
  let socket;
  class CaptureSocket extends FakeProposalSocket {
    constructor(url) { super(url); socket = this; }
  }
  const request = {
    proposal: 1, contract_type: "CALL", currency: "USD",
    underlying_symbol: "R_50", amount: 1, basis: "stake",
    duration: 5, duration_unit: "m", req_id: 8301
  };
  const result = await fetchDerivProposalSession(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=secret",
    "R_50",
    () => request,
    CaptureSocket
  );
  assert.equal(result.catalogue.msg_type, "contracts_for");
  assert.equal(result.proposal.msg_type, "proposal");
  assert.deepEqual(socket.sent, [
    { contracts_for: "R_50", req_id: 8300 },
    request
  ]);
  assert.equal(socket.sent.some(item => "buy" in item || "sell" in item), false);
});

test("fails closed on provider errors and invalid proposal builder output", async () => {
  class ErrorSocket extends FakeProposalSocket {
    constructor(url) { super(url, 8300); }
  }
  await assert.rejects(fetchDerivProposalSession(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=secret",
    "R_50", () => ({ proposal: 1, req_id: 8301 }), ErrorSocket
  ), /DERIV_PROPOSAL_PROVIDER_ERROR/);

  class CaptureSocket extends FakeProposalSocket {}
  await assert.rejects(fetchDerivProposalSession(
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=secret",
    "R_50", () => null, CaptureSocket
  ), /DERIV_PROPOSAL_REQUEST_NOT_AUTHORIZED/);
});
