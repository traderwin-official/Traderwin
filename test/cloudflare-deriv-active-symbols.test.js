import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDerivActiveSymbolsHandler,
  normalizeDerivActiveSymbols
} from '../lib/cloudflare-deriv-active-symbols.js';

const env = {
  APP_RATE_LIMITER_TOKEN: 'test-only-token',
  APP_RATE_LIMITER: {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      assert.equal(body.limit, 20);
      assert.equal(body.windowSeconds, 60);
      return Response.json({ allowed: true });
    }
  }
};

function request({ method = 'GET', ip = '192.0.2.20' } = {}) {
  return new Request('https://tiger-scheme-preview.example/api/deriv/active-symbols', {
    method,
    headers: ip ? { 'CF-Connecting-IP': ip } : {}
  });
}

function mockSocketClass({ payload, raw, wrongRequestFirst = false, fail = false, neverOpen = false } = {}) {
  const instances = [];
  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      this.closed = false;
      instances.push(this);
      if (!neverOpen) queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(value) {
      this.sent.push(value);
      if (fail) {
        queueMicrotask(() => this.dispatchEvent(new Event('error')));
        return;
      }
      const requestPayload = JSON.parse(value);
      const sendPayload = (data) => queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data }));
      });
      if (wrongRequestFirst) {
        sendPayload(JSON.stringify({ req_id: requestPayload.req_id + 1, msg_type: 'active_symbols', active_symbols: [] }));
      }
      sendPayload(raw !== undefined ? raw : JSON.stringify(payload));
    }
    close() { this.closed = true; }
  }
  return { MockWebSocket, instances };
}

const providerPayload = {
  msg_type: 'active_symbols',
  req_id: 7319,
  active_symbols: [{
    underlying_symbol: 'R_100',
    underlying_symbol_name: 'Volatility 100 Index',
    underlying_symbol_type: 'stockindex',
    market: 'synthetic_index',
    subgroup: 'synthetics',
    submarket: 'random_index',
    pip_size: 0.01,
    exchange_is_open: 1,
    is_trading_suspended: 0
  }]
};

test('normalizes Deriv active symbols and does not activate instruments', () => {
  const result = normalizeDerivActiveSymbols(providerPayload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.symbols[0], {
    symbol: 'R_100',
    name: 'Volatility 100 Index',
    market: 'synthetic_index',
    subgroup: 'synthetics',
    submarket: 'random_index',
    symbol_type: 'stockindex',
    pip_size: 0.01,
    exchange_is_open: true,
    is_trading_suspended: false
  });
});

test('normalizer drops malformed and duplicate symbols', () => {
  const result = normalizeDerivActiveSymbols({
    msg_type: 'active_symbols',
    active_symbols: [
      { underlying_symbol: 'EURUSD', underlying_symbol_name: 'EUR/USD' },
      { underlying_symbol: 'EURUSD', underlying_symbol_name: 'Duplicate' },
      { underlying_symbol: 'bad symbol' },
      null
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.symbols.length, 1);
  assert.equal(result.symbols[0].name, 'EUR/USD');
});

test('normalizer rejects wrong message types and empty valid catalogues', () => {
  assert.equal(normalizeDerivActiveSymbols({ msg_type: 'tick', active_symbols: [] }).reason, 'INVALID_ACTIVE_SYMBOLS_RESPONSE');
  assert.equal(normalizeDerivActiveSymbols({ msg_type: 'active_symbols', active_symbols: [{ underlying_symbol: ' ' }] }).reason, 'NO_VALID_ACTIVE_SYMBOLS');
});

test('returns verified, read-only catalogue from Deriv', async () => {
  const { MockWebSocket, instances } = mockSocketClass({ payload: providerPayload, wrongRequestFirst: true });
  const handler = createDerivActiveSymbolsHandler({
    WebSocketImpl: MockWebSocket,
    now: () => Date.parse('2026-11-19T17:00:00.000Z')
  });
  const response = await handler({ request: request(), env });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.provider, 'DERIV_PUBLIC_MARKET_DATA');
  assert.equal(body.verified_from_provider_response, true);
  assert.equal(body.instruments_activated_in_platform, false);
  assert.equal(body.symbols[0].symbol, 'R_100');
  assert.equal(instances[0].url, 'wss://api.derivws.com/trading/v1/options/ws/public');
  assert.deepEqual(JSON.parse(instances[0].sent[0]), { active_symbols: 'brief', req_id: 7319 });
  assert.equal(instances[0].closed, true);
  assert.match(response.headers.get('Cache-Control'), /s-maxage=60/);
});

test('rejects non-GET requests', async () => {
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: mockSocketClass({ payload: providerPayload }).MockWebSocket });
  const response = await handler({ request: request({ method: 'POST' }), env });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
});

test('fails closed when Cloudflare client IP is missing', async () => {
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: mockSocketClass({ payload: providerPayload }).MockWebSocket });
  const response = await handler({ request: request({ ip: '' }), env });
  assert.equal(response.status, 503);
});

test('fails closed until the rate-limiter binding and token exist', async () => {
  const { MockWebSocket, instances } = mockSocketClass({ payload: providerPayload });
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: MockWebSocket });
  const response = await handler({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.equal(instances.length, 0);
});

test('rate limiting blocks excessive requests before opening a WebSocket', async () => {
  const { MockWebSocket, instances } = mockSocketClass({ payload: providerPayload });
  const limitedEnv = {
    ...env,
    APP_RATE_LIMITER: { async fetch() { return Response.json({ allowed: false, retryAfterSeconds: 23 }); } }
  };
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: MockWebSocket });
  const response = await handler({ request: request(), env: limitedEnv });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '23');
  assert.equal(instances.length, 0);
});

test('rate-limiter errors fail closed', async () => {
  const { MockWebSocket, instances } = mockSocketClass({ payload: providerPayload });
  const brokenEnv = {
    ...env,
    APP_RATE_LIMITER: { async fetch() { throw new Error('unavailable'); } }
  };
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: MockWebSocket });
  const response = await handler({ request: request(), env: brokenEnv });
  assert.equal(response.status, 503);
  assert.equal(instances.length, 0);
});

test('returns 502 for provider errors and malformed messages', async () => {
  for (const payload of [
    { req_id: 7319, error: { code: 'InvalidRequest' } },
    { req_id: 7319, msg_type: 'active_symbols', active_symbols: [] }
  ]) {
    const { MockWebSocket } = mockSocketClass({ payload });
    const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: MockWebSocket });
    const response = await handler({ request: request(), env });
    assert.equal(response.status, 502);
  }
  const { MockWebSocket: MalformedSocket } = mockSocketClass({ raw: '{bad json' });
  const malformed = await createDerivActiveSymbolsHandler({ WebSocketImpl: MalformedSocket })({
    request: request(), env
  });
  assert.equal(malformed.status, 502);
});

test('returns 502 when the WebSocket connection fails', async () => {
  const { MockWebSocket } = mockSocketClass({ fail: true });
  const handler = createDerivActiveSymbolsHandler({ WebSocketImpl: MockWebSocket });
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 502);
});

test('returns 504 when Deriv does not open before timeout', async () => {
  const { MockWebSocket } = mockSocketClass({ neverOpen: true });
  const handler = createDerivActiveSymbolsHandler({
    WebSocketImpl: MockWebSocket,
    setTimeoutImpl(callback) { queueMicrotask(callback); return 1; },
    clearTimeoutImpl() {}
  });
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 504);
});
