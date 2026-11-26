const validText = value => typeof value === "string" && value.trim().length > 0;
const finite = value => typeof value === "number" && Number.isFinite(value);

function safeAccountRef(value) {
  if (!validText(value) || value.length > 160) throw new RangeError("Invalid MT5 account reference.");
  return value;
}

/**
 * Server-only client for a separately hosted MT5 terminal bridge.
 * This adapter is DEMO-only. The bridge must run beside a logged-in MT5
 * terminal; Vercel/serverless cannot load the Windows terminal directly.
 *
 * Closing is disabled by default. It can only be enabled explicitly for
 * end-to-end DEMO validation after the terminal bridge has been verified.
 */
export function createMt5BridgeAdapter({
  baseUrl,
  apiToken,
  fetchImpl = globalThis.fetch,
  maxQuoteAgeMs = 5000,
  allowDemoClose = false,
  now = () => Date.now()
} = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new TypeError("A valid MT5 bridge URL is required."); }
  if (endpoint.protocol !== "https:" || !validText(apiToken) || apiToken.length < 24 ||
      typeof fetchImpl !== "function" || !Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 ||
      typeof allowDemoClose !== "boolean" || typeof now !== "function") {
    throw new TypeError("MT5 bridge requires HTTPS, a server-side token, fetch, a positive quote-age limit and explicit close configuration.");
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
      if (scope?.accountMode !== "DEMO") {
        throw new Error("MT5 integration is DEMO-only; REAL account snapshots are disabled.");
      }
      const accountRef = safeAccountRef(scope.accountRef);
      const payload = await request(`/v1/accounts/${encodeURIComponent(accountRef)}/portfolio`);
      if (payload.accountRef !== accountRef || payload.accountMode !== "DEMO" ||
          payload.connected !== true || !validText(payload.quoteSource) ||
          !validText(payload.asOf) || !payload.emergency) {
        throw new Error("MT5 bridge account identity or connection status could not be verified.");
      }
      const asOfMs = Date.parse(payload.asOf);
      const observedNow = now();
      const ageMs = observedNow - asOfMs;
      const providerMaxAge = payload.maxQuoteAgeMs;
      if (!Number.isFinite(asOfMs) || !Number.isFinite(observedNow) ||
          !Number.isSafeInteger(providerMaxAge) || providerMaxAge <= 0 ||
          ageMs < 0 || ageMs > Math.min(providerMaxAge, maxQuoteAgeMs)) {
        throw new Error("MT5 bridge quote timestamp is stale, future-dated or outside the allowed freshness window.");
      }
      const positions = payload.positions;
      if (!Array.isArray(positions)) throw new Error("MT5 bridge did not return a positions array.");
      const normalized = positions.map(position => {
        if (!position || !validText(String(position.ticket ?? "")) ||
            !["BOT", "MANUAL"].includes(position.source) ||
            !finite(position.unrealizedProfitUsd) || position.valuationStatus !== "VERIFIED" ||
            position.accountRef !== accountRef || position.accountMode !== "DEMO" ||
            !validText(position.symbol) || !["BUY", "SELL"].includes(position.direction) ||
            !finite(position.volume) || position.volume <= 0) {
          throw new Error("MT5 position has unverified identity, instrument or USD valuation.");
        }
        return {
          id: String(position.ticket),
          brokerPositionId: String(position.ticket),
          userId: scope.userId,
          accountMode: "DEMO",
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
        maxAgeMs: Math.min(providerMaxAge, maxQuoteAgeMs),
        emergency: payload.emergency
      };
    },

    async closePosition(position, { idempotencyKey, reason } = {}) {
      if (!allowDemoClose) {
        throw new Error("MT5 DEMO close requests are disabled until explicit end-to-end validation is enabled.");
      }
      if (position?.broker !== "MT5" || position?.accountMode !== "DEMO" ||
          !validText(position.brokerPositionId) || !validText(idempotencyKey) || !validText(reason)) {
        throw new TypeError("Only a validated MT5 DEMO position can be closed.");
      }
      const accountRef = safeAccountRef(position.accountRef);
      const result = await request(
        `/v1/accounts/${encodeURIComponent(accountRef)}/positions/${encodeURIComponent(position.brokerPositionId)}/close`,
        {
          method: "POST",
          idempotencyKey,
          body: {
            accountMode: "DEMO",
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
