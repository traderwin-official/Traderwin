const validText = value => typeof value === "string" && value.trim().length > 0;
const finite = value => typeof value === "number" && Number.isFinite(value);

function safeAccountRef(value) {
  if (!validText(value) || value.length > 160) throw new RangeError("Invalid MT5 account reference.");
  return value;
}

/**
 * Server-only client for a separately hosted MT5 terminal bridge.
 * The bridge must run beside a logged-in MT5 terminal (MetaQuotes Python
 * integration is terminal-bound); Vercel/serverless must never pretend it
 * can directly load the Windows terminal or MetaTrader5 Python package.
 *
 * Expected bridge contract:
 * GET  /v1/accounts/{accountRef}/portfolio
 * POST /v1/accounts/{accountRef}/positions/{ticket}/close
 * All P&L must already be converted to USD by the bridge using verified
 * account-currency conversion data. Unknown conversion => bridge returns
 * valuationStatus=UNAVAILABLE and Traderwin blocks portfolio actions.
 */
export function createMt5BridgeAdapter({
  baseUrl,
  apiToken,
  fetchImpl = globalThis.fetch,
  maxQuoteAgeMs = 5000
} = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new TypeError("A valid MT5 bridge URL is required."); }
  if (endpoint.protocol !== "https:" || !validText(apiToken) || apiToken.length < 24 ||
      typeof fetchImpl !== "function" || !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {
    throw new TypeError("MT5 bridge requires HTTPS, a server-side token, fetch and a positive quote-age limit.");
  }
  const root = endpoint.toString().replace(/\/$/, "");

  async function request(path, options = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`MT5 bridge request failed (${response.status}).`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object") throw new Error("Invalid MT5 bridge response.");
    return payload;
  }

  return {
    broker: "MT5",
    async loadSnapshot(scope) {
      const accountRef = safeAccountRef(scope.accountRef);
      const payload = await request(`/v1/accounts/${encodeURIComponent(accountRef)}/portfolio`);
      if (payload.accountRef !== accountRef || payload.accountMode !== scope.accountMode ||
          payload.connected !== true || !validText(payload.quoteSource) ||
          !validText(payload.asOf) || !payload.emergency) {
        throw new Error("MT5 bridge account identity or connection status could not be verified.");
      }
      const positions = payload.positions;
      if (!Array.isArray(positions)) throw new Error("MT5 bridge did not return a positions array.");
      const normalized = positions.map(position => {
        if (!position || !validText(String(position.ticket ?? "")) ||
            !["BOT", "MANUAL"].includes(position.source) ||
            !finite(position.unrealizedProfitUsd) || position.valuationStatus !== "VERIFIED" ||
            position.accountRef !== accountRef || position.accountMode !== scope.accountMode) {
          throw new Error("MT5 position has unverified identity or USD valuation.");
        }
        return {
          id: String(position.ticket),
          brokerPositionId: String(position.ticket),
          userId: scope.userId,
          accountMode: scope.accountMode,
          broker: "MT5",
          accountRef,
          source: position.source,
          status: "OPEN",
          symbol: position.symbol,
          direction: position.direction,
          volume: position.volume,
          profitUsd: position.unrealizedProfitUsd,
          profitCurrency: "USD"
        };
      });
      return {
        positions: normalized,
        source: payload.quoteSource,
        asOf: payload.asOf,
        maxAgeMs: Math.min(payload.maxQuoteAgeMs || maxQuoteAgeMs, maxQuoteAgeMs),
        emergency: payload.emergency
      };
    },

    async closePosition(position, { idempotencyKey, reason }) {
      if (position?.broker !== "MT5" || !validText(position.brokerPositionId) ||
          !validText(idempotencyKey) || !validText(reason)) {
        throw new TypeError("Invalid MT5 close request.");
      }
      const accountRef = safeAccountRef(position.accountRef);
      const result = await request(
        `/v1/accounts/${encodeURIComponent(accountRef)}/positions/${encodeURIComponent(position.brokerPositionId)}/close`,
        {
          method: "POST",
          idempotencyKey,
          body: {
            accountMode: position.accountMode,
            reason,
            expectedPositionSource: position.source
          }
        }
      );
      return {
        closed: result.closed === true,
        status: validText(result.status) ? result.status : "UNKNOWN",
        brokerDealId: result.dealId ? String(result.dealId) : null
      };
    }
  };
}
