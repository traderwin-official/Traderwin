export async function fetchAccountScopedWsSnapshot(url, WebSocketImpl = globalThis.WebSocket) {
  if (typeof WebSocketImpl !== "function") throw new Error("WEBSOCKET_RUNTIME_UNAVAILABLE");
  const socket = new WebSocketImpl(url);
  return new Promise((resolve, reject) => {
    const responses = new Map();
    const valuationResponses = new Map();
    const valuationRequests = new Map();
    let portfolioContracts = null;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };
    const maybeFinish = () => {
      if (!responses.has(7101) || !responses.has(7102) || portfolioContracts === null) return;
      if (valuationResponses.size !== portfolioContracts.length) return;
      finish(null, {
        balance: responses.get(7101),
        portfolio: responses.get(7102),
        valuations: portfolioContracts.map((contract) =>
          valuationResponses.get(contract.contract_id))
      });
    };
    const timer = setTimeout(() => finish(new Error("DERIV_ACCOUNT_WS_TIMEOUT")), 10000);
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ balance: 1, req_id: 7101 }));
        socket.send(JSON.stringify({ portfolio: 1, req_id: 7102 }));
      } catch {
        finish(new Error("DERIV_ACCOUNT_WS_SEND_FAILED"));
      }
    });
    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        finish(new Error("DERIV_ACCOUNT_WS_INVALID_JSON"));
        return;
      }
      const requestId = payload?.req_id;
      if (payload.error && (requestId === 7101 || requestId === 7102 || valuationRequests.has(requestId))) {
        finish(new Error("DERIV_ACCOUNT_WS_PROVIDER_ERROR"));
        return;
      }
      if (requestId === 7101) {
        if (payload.msg_type !== "balance") {
          finish(new Error("DERIV_ACCOUNT_BALANCE_RESPONSE_TYPE_INVALID"));
          return;
        }
        responses.set(7101, payload);
        maybeFinish();
        return;
      }
      if (requestId === 7102) {
        if (payload.msg_type !== "portfolio" || !Array.isArray(payload?.portfolio?.contracts)) {
          finish(new Error("DERIV_ACCOUNT_PORTFOLIO_RESPONSE_INVALID"));
          return;
        }
        responses.set(7102, payload);
        portfolioContracts = payload.portfolio.contracts;
        if (portfolioContracts.length > 50) {
          finish(new Error("DERIV_ACCOUNT_OPEN_CONTRACT_LIMIT_EXCEEDED"));
          return;
        }
        const portfolioIds = new Set();
        for (let index = 0; index < portfolioContracts.length; index += 1) {
          const contractId = portfolioContracts[index]?.contract_id;
          if (!Number.isSafeInteger(contractId) || contractId <= 0 || portfolioIds.has(contractId)) {
            finish(new Error("DERIV_ACCOUNT_PORTFOLIO_CONTRACT_ID_INVALID"));
            return;
          }
          portfolioIds.add(contractId);
          const valuationReqId = 7200 + index;
          valuationRequests.set(valuationReqId, contractId);
          try {
            socket.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: contractId,
              req_id: valuationReqId
            }));
          } catch {
            finish(new Error("DERIV_ACCOUNT_WS_SEND_FAILED"));
            return;
          }
        }
        maybeFinish();
        return;
      }
      if (valuationRequests.has(requestId)) {
        if (payload.msg_type !== "proposal_open_contract" ||
            payload?.proposal_open_contract?.contract_id !== valuationRequests.get(requestId)) {
          finish(new Error("DERIV_ACCOUNT_CONTRACT_VALUATION_MISMATCH"));
          return;
        }
        valuationResponses.set(valuationRequests.get(requestId), payload);
        maybeFinish();
      }
    });
    socket.addEventListener("error", () => finish(new Error("DERIV_ACCOUNT_WS_ERROR")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("DERIV_ACCOUNT_WS_CLOSED_EARLY"));
    });
  });
}
