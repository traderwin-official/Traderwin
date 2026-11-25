/**
 * Account-scoped, read-only Deriv options catalogue + proposal flow.
 * Sends contracts_for followed by proposal only; never sends buy/sell.
 */
export async function fetchDerivProposalSession(
  url,
  symbol,
  buildProposalRequest,
  WebSocketImpl = globalThis.WebSocket
) {
  if (typeof WebSocketImpl !== "function") throw new Error("DERIV_PROPOSAL_WEBSOCKET_UNAVAILABLE");
  if (typeof symbol !== "string" || !/^[A-Za-z0-9_]{2,30}$/.test(symbol) ||
      typeof buildProposalRequest !== "function") {
    throw new Error("DERIV_PROPOSAL_SESSION_INPUT_INVALID");
  }
  const socket = new WebSocketImpl(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let proposalRequest = null;
    let cataloguePayload = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("DERIV_PROPOSAL_SESSION_TIMEOUT")), 10000);
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ contracts_for: symbol, req_id: 8300 }));
      } catch {
        finish(new Error("DERIV_PROPOSAL_SESSION_SEND_FAILED"));
      }
    });
    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        finish(new Error("DERIV_PROPOSAL_SESSION_INVALID_JSON"));
        return;
      }
      if (payload?.error && [8300, 8301].includes(payload?.req_id)) {
        finish(new Error("DERIV_PROPOSAL_PROVIDER_ERROR"));
        return;
      }
      if (payload?.req_id === 8300) {
        if (cataloguePayload || payload.msg_type !== "contracts_for" ||
            payload?.echo_req?.contracts_for !== symbol) {
          finish(new Error("DERIV_PROPOSAL_CATALOGUE_RESPONSE_MISMATCH"));
          return;
        }
        cataloguePayload = payload;
        try {
          proposalRequest = buildProposalRequest(payload);
        } catch {
          finish(new Error("DERIV_PROPOSAL_REQUEST_BUILD_FAILED"));
          return;
        }
        if (!proposalRequest || proposalRequest.req_id !== 8301 || proposalRequest.proposal !== 1) {
          finish(new Error("DERIV_PROPOSAL_REQUEST_NOT_AUTHORIZED"));
          return;
        }
        try {
          socket.send(JSON.stringify(proposalRequest));
        } catch {
          finish(new Error("DERIV_PROPOSAL_SESSION_SEND_FAILED"));
        }
        return;
      }
      if (payload?.req_id === 8301) {
        if (!cataloguePayload || !proposalRequest || payload.msg_type !== "proposal") {
          finish(new Error("DERIV_PROPOSAL_RESPONSE_UNEXPECTED"));
          return;
        }
        finish(null, { catalogue: cataloguePayload, proposal: payload, request: proposalRequest });
      }
    });
    socket.addEventListener("error", () => finish(new Error("DERIV_PROPOSAL_SESSION_SOCKET_ERROR")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("DERIV_PROPOSAL_SESSION_CLOSED_EARLY"));
    });
  });
}
