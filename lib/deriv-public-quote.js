const ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const SYMBOLS = {
  XAUUSD: ["frxXAUUSD", "XAUUSD"],
  XAGUSD: ["frxXAGUSD", "XAGUSD"],
  EURUSD: ["frxEURUSD", "EURUSD"],
  GBPUSD: ["frxGBPUSD", "GBPUSD"],
  USDJPY: ["frxUSDJPY", "USDJPY"],
  AUDUSD: ["frxAUDUSD", "AUDUSD"],
  USDCAD: ["frxUSDCAD", "USDCAD"],
  USDCHF: ["frxUSDCHF", "USDCHF"],
  NZDUSD: ["frxNZDUSD", "NZDUSD"],
  BTCUSD: ["cryBTCUSD", "BTCUSD"],
  ETHUSD: ["cryETHUSD", "ETHUSD"],
  R_10: ["R_10"],
  R_25: ["R_25"],
  R_50: ["R_50"],
  R_75: ["R_75"],
  R_100: ["R_100"]
};

const normalise = value => String(value || "").trim().toUpperCase().replace(/[\\s/.-]/g, "");
const decode = event => {
  const value = event?.data;
  return JSON.parse(typeof value === "string" ? value : value?.toString?.() || "");
};

/**
 * Fetch one independently verified quote from Deriv's unauthenticated,
 * read-only public market-data WebSocket. Never accept a browser quote.
 */
export function getDerivPublicQuote(instrument, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const timeoutMs = options.timeoutMs || 8000;
  const now = options.now || (() => Date.now());
  if (typeof WebSocketImpl !== "function") {
    return Promise.reject(new Error("This server runtime does not provide WebSocket support."));
  }

  const key = normalise(instrument);
  const candidates = SYMBOLS[key] || (key.startsWith("FRX") || key.startsWith("CRY") || /^R_\\d+$/.test(key)
    ? [String(instrument).trim()] : []);
  if (!candidates.length) {
    return Promise.reject(new Error("This instrument is not yet supported by the verified Deriv DEMO quote adapter."));
  }

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let selectedSymbol = null;
    const timer = setTimeout(() => finish(new Error("Deriv market quote timed out. Try again when the market feed is available.")), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    }

    try {
      socket = new WebSocketImpl(ENDPOINT);
      socket.onopen = () => socket.send(JSON.stringify({ active_symbols: "brief", req_id: 1 }));
      socket.onerror = () => finish(new Error("Could not connect to Deriv's public market-data service."));
      socket.onmessage = event => {
        let message;
        try { message = decode(event); }
        catch { return finish(new Error("Deriv returned an unreadable market-data response.")); }
        if (message.error) return finish(new Error("Deriv rejected the market-data request."));
        if (message.msg_type === "active_symbols") {
          const active = Array.isArray(message.active_symbols) ? message.active_symbols : [];
          const match = active.find(item => candidates.includes(String(item.symbol || "")));
          if (!match) return finish(new Error("This instrument is not currently available on Deriv."));
          selectedSymbol = match.symbol;
          socket.send(JSON.stringify({ ticks: selectedSymbol, req_id: 2 }));
          return;
        }
        if (message.msg_type === "tick" && message.tick) {
          const quote = Number(message.tick.quote);
          const epoch = Number(message.tick.epoch);
          const symbol = String(message.tick.symbol || selectedSymbol || "");
          const asOfMs = epoch * 1000;
          if (!selectedSymbol || symbol !== selectedSymbol || !Number.isFinite(quote) || quote <= 0 ||
              !Number.isFinite(epoch) || epoch <= 0 || Math.abs(now() - asOfMs) > 30000) {
            return finish(new Error("Deriv returned a stale or invalid quote; no paper order was recorded."));
          }
          return finish(null, {
            instrument: String(instrument).trim(),
            providerSymbol: selectedSymbol,
            quote,
            quoteAsOf: new Date(asOfMs).toISOString(),
            receivedAt: new Date(now()).toISOString(),
            source: "DERIV"
          });
        }
      };
    } catch {
      finish(new Error("Could not open Deriv's public market-data connection."));
    }
  });
}
