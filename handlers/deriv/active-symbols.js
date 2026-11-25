import { normalizeDerivActiveSymbols } from "../../lib/deriv/active-symbols.js";

const DERIV_PUBLIC_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const REQUEST_ID = 7319;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=120");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const WebSocketClient = globalThis.WebSocket;
  if (typeof WebSocketClient !== "function") {
    return res.status(503).json({ error: "Server WebSocket support is unavailable." });
  }

  let socket;
  let timeout;
  let settled = false;

  const finish = (status, body) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    try { socket?.close(); } catch {}
    return res.status(status).json(body);
  };

  try {
    socket = new WebSocketClient(DERIV_PUBLIC_WS);
    timeout = setTimeout(() => {
      finish(504, { error: "Deriv market catalogue request timed out." });
    }, 8000);

    socket.addEventListener("open", () => {
      if (settled) return;
      socket.send(JSON.stringify({
        active_symbols: "brief",
        req_id: REQUEST_ID
      }));
    });

    socket.addEventListener("message", (event) => {
      if (settled) return;
      let payload;
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        payload = JSON.parse(raw);
      } catch {
        return finish(502, { error: "Deriv returned an unreadable market catalogue response." });
      }

      if (payload.req_id !== REQUEST_ID) return;
      if (payload.error) {
        return finish(502, { error: "Deriv could not provide the active market catalogue." });
      }
      if (payload.msg_type !== "active_symbols") return;

      const normalized = normalizeDerivActiveSymbols(payload);
      if (!normalized.ok) {
        return finish(502, { error: "Deriv returned no valid active market symbols." });
      }

      return finish(200, {
        provider: "DERIV_PUBLIC_MARKET_DATA",
        fetched_at: new Date().toISOString(),
        verified_from_provider_response: true,
        instruments_activated_in_platform: false,
        note: "Discovery only. A returned symbol is not automatically enabled for trading or added to the platform's approved instrument list.",
        symbols: normalized.symbols
      });
    });

    socket.addEventListener("error", () => {
      finish(502, { error: "Could not connect to Deriv's public market-data service." });
    });

    socket.addEventListener("close", () => {
      if (!settled) finish(502, { error: "Deriv closed the market catalogue connection unexpectedly." });
    });
  } catch {
    return finish(502, { error: "Could not initialize Deriv market-data connection." });
  }
}
