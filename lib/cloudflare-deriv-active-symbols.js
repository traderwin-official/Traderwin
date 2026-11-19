import { normalizeDerivActiveSymbolsImpl } from './deriv-active-symbols-normalizer.js';

const DERIV_PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const REQUEST_ID = 7319;
const RATE_LIMIT = 20;
const RATE_WINDOW_SECONDS = 60;
const MAX_RESPONSE_CHARS = 1_000_000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || '').trim().slice(0, 100);
}

async function consumeLimit({ env, key }) {
  const limiter = env.APP_RATE_LIMITER;
  const token = env.APP_RATE_LIMITER_TOKEN;
  if (!limiter || typeof limiter.fetch !== 'function' || !token) {
    return {
      ok: false,
      response: json({ error: 'Market catalogue is temporarily unavailable while rate protection is configured.' }, 503)
    };
  }

  try {
    const response = await limiter.fetch('https://rate-limit.internal/check', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key,
        limit: RATE_LIMIT,
        windowSeconds: RATE_WINDOW_SECONDS
      })
    });
    if (!response.ok) {
      return {
        ok: false,
        response: json({ error: 'Market catalogue rate protection is unavailable.' }, 503)
      };
    }

    const result = await response.json().catch(() => null);
    if (!result || typeof result.allowed !== 'boolean') {
      return {
        ok: false,
        response: json({ error: 'Market catalogue rate protection returned an invalid response.' }, 503)
      };
    }
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.min(120, Number(result.retryAfterSeconds) || 60));
      return {
        ok: false,
        response: json(
          { error: 'Too many market catalogue requests. Please wait before trying again.' },
          429,
          { 'Retry-After': String(retryAfter) }
        )
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      response: json({ error: 'Market catalogue rate protection is unavailable.' }, 503)
    };
  }
}

async function eventDataText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  throw new Error('Unsupported Deriv message format');
}

export function normalizeDerivActiveSymbols(payload) {
  return normalizeDerivActiveSymbolsImpl(payload);
}

export function createDerivActiveSymbolsHandler(dependencies = {}) {
  const now = dependencies.now || Date.now;
  const setTimer = dependencies.setTimeoutImpl || setTimeout;
  const clearTimer = dependencies.clearTimeoutImpl || clearTimeout;

  return async function onRequestGet({ request, env }) {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
    }

    const ip = clientIp(request);
    if (!ip) {
      return json({ error: 'Request origin could not be verified.' }, 503);
    }

    const rate = await consumeLimit({
      env,
      key: 'deriv-active-symbols-ip:' + ip
    });
    if (!rate.ok) return rate.response;

    const WebSocketClient = dependencies.WebSocketImpl || globalThis.WebSocket;
    if (typeof WebSocketClient !== 'function') {
      return json({ error: 'Server WebSocket support is unavailable.' }, 503);
    }

    return new Promise((resolve) => {
      let socket;
      let timer;
      let settled = false;

      const finish = (status, body, headers = {}) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimer(timer);
        try { socket?.close(); } catch {}
        resolve(json(body, status, headers));
      };

      try {
        socket = new WebSocketClient(DERIV_PUBLIC_WS);
        timer = setTimer(() => {
          finish(504, { error: 'Deriv market catalogue request timed out.' });
        }, 8000);

        socket.addEventListener('open', () => {
          if (settled) return;
          try {
            socket.send(JSON.stringify({
              active_symbols: 'brief',
              req_id: REQUEST_ID
            }));
          } catch {
            finish(502, { error: 'Could not request Deriv market symbols.' });
          }
        });

        socket.addEventListener('message', (event) => {
          if (settled) return;
          void (async () => {
            try {
              const raw = await eventDataText(event.data);
              if (raw.length > MAX_RESPONSE_CHARS) {
                return finish(502, { error: 'Deriv market catalogue response was too large.' });
              }
              const payload = JSON.parse(raw);
              if (payload?.req_id !== REQUEST_ID) return;
              if (payload.error) {
                return finish(502, { error: 'Deriv could not provide the active market catalogue.' });
              }
              if (payload.msg_type !== 'active_symbols') return;

              const normalized = normalizeDerivActiveSymbolsImpl(payload);
              if (!normalized.ok) {
                return finish(502, { error: 'Deriv returned no valid active market symbols.' });
              }

              return finish(200, {
                provider: 'DERIV_PUBLIC_MARKET_DATA',
                fetched_at: new Date(now()).toISOString(),
                verified_from_provider_response: true,
                instruments_activated_in_platform: false,
                note: 'Discovery only. A returned symbol is not automatically enabled for trading or added to the platform approved instrument list.',
                symbols: normalized.symbols
              }, {
                'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120'
              });
            } catch {
              finish(502, { error: 'Deriv returned an unreadable market catalogue response.' });
            }
          })();
        });

        socket.addEventListener('error', () => {
          finish(502, { error: 'Could not connect to Deriv public market-data service.' });
        });

        socket.addEventListener('close', () => {
          if (!settled) {
            finish(502, { error: 'Deriv closed the market catalogue connection unexpectedly.' });
          }
        });
      } catch {
        finish(502, { error: 'Could not initialize Deriv market-data connection.' });
      }
    });
  };
}
