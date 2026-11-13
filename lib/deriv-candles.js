const ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const SYMBOLS = {
  XAUUSD: ["frxXAUUSD", "XAUUSD"], XAGUSD: ["frxXAGUSD", "XAGUSD"],
  EURUSD: ["frxEURUSD", "EURUSD"], GBPUSD: ["frxGBPUSD", "GBPUSD"],
  USDJPY: ["frxUSDJPY", "USDJPY"], AUDUSD: ["frxAUDUSD", "AUDUSD"],
  USDCAD: ["frxUSDCAD", "USDCAD"], USDCHF: ["frxUSDCHF", "USDCHF"],
  NZDUSD: ["frxNZDUSD", "NZDUSD"], BTCUSD: ["cryBTCUSD", "BTCUSD"],
  ETHUSD: ["cryETHUSD", "ETHUSD"], R_10: ["R_10"], R_25: ["R_25"],
  R_50: ["R_50"], R_75: ["R_75"], R_100: ["R_100"]
};
const TIMEFRAMES = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400 };
const normalise = value => String(value || "").trim().toUpperCase().replace(/[\s/.-]/g, "");
const decode = event => {
  const value = event?.data;
  return JSON.parse(typeof value === "string" ? value : value?.toString?.() || "");
};

export function getDerivCandles(instrument, timeframe = "M15", options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const timeoutMs = options.timeoutMs || 10000;
  const now = options.now || (() => Date.now());
  const granularity = TIMEFRAMES[String(timeframe).toUpperCase()];
  const key = normalise(instrument);
  const candidates = SYMBOLS[key] || (/^[A-Z]{6}$/.test(key)
    ? ["frx" + key, "cry" + key, key]
    : key.startsWith("FRX") || key.startsWith("CRY") || /^R_\d+$/.test(key)
      ? [String(instrument).trim()] : []);
  if (typeof WebSocketImpl !== "function") return Promise.reject(new Error("Server WebSocket support is unavailable."));
  if (!granularity) return Promise.reject(new Error("Choose M1, M5, M15, H1 or H4 for market analysis."));
  if (!candidates.length) return Promise.reject(new Error("This instrument is not supported by the Deriv market-analysis adapter."));

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let providerSymbol = null;
    const timer = setTimeout(() => finish(new Error("Deriv candle-history request timed out.")), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      if (error) reject(error); else resolve(result);
    }
    try {
      socket = new WebSocketImpl(ENDPOINT);
      socket.onopen = () => socket.send(JSON.stringify({ active_symbols: "brief", req_id: 1 }));
      socket.onerror = () => finish(new Error("Could not connect to Deriv market data."));
      socket.onmessage = event => {
        let message;
        try { message = decode(event); }
        catch { return finish(new Error("Deriv returned unreadable market data.")); }
        if (message.error) return finish(new Error("Deriv rejected the candle-history request."));
        if (message.msg_type === "active_symbols") {
          const active = Array.isArray(message.active_symbols) ? message.active_symbols : [];
          const match = active.find(item => candidates.includes(String(item.symbol || "")));
          if (!match) return finish(new Error("This instrument is not currently available on Deriv."));
          providerSymbol = match.symbol;
          socket.send(JSON.stringify({
            ticks_history: providerSymbol, count: 120, end: "latest",
            style: "candles", granularity, req_id: 2
          }));
          return;
        }
        if (message.msg_type === "candles" && Array.isArray(message.candles)) {
          const completed = message.candles.map(c => ({
            epoch: Number(c.epoch),
            open: Number(c.open), high: Number(c.high),
            low: Number(c.low), close: Number(c.close)
          })).filter(c => [c.epoch,c.open,c.high,c.low,c.close].every(Number.isFinite) &&
            c.epoch > 0 && c.open > 0 && c.low > 0 && c.high >= c.low &&
            c.open >= c.low && c.open <= c.high && c.close >= c.low && c.close <= c.high &&
            (c.epoch + granularity) * 1000 <= now());
          if (completed.length < 35) return finish(new Error("Deriv returned fewer than 35 completed candles."));
          const latest = completed[completed.length - 1];
          const ageMs = now() - (latest.epoch + granularity) * 1000;
          if (ageMs > granularity * 2000) return finish(new Error("Latest completed candle is stale; no fresh strategy analysis was produced."));
          return finish(null, {
            instrument: String(instrument).trim(),
            providerSymbol,
            timeframe: String(timeframe).toUpperCase(),
            granularity,
            candles: completed.slice(-100),
            source: "DERIV",
            latestCandleAsOf: new Date((latest.epoch + granularity) * 1000).toISOString(),
            receivedAt: new Date(now()).toISOString()
          });
        }
      };
    } catch {
      finish(new Error("Could not open Deriv market-data connection."));
    }
  });
}
