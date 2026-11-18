import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBotLicenseHandler } from '../lib/cloudflare-bot-license.js';

const key = 'TW-AB12-CD34-EF56-GH78-IJ90-KL12';
const envBase = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder',
  APP_RATE_LIMITER_TOKEN: 'test-limiter-token'
};

function makeRequest(body, options = {}) {
  return new Request('https://preview.example.pages.dev/api/bot-license/activate', {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': options.ip || '192.0.2.10'
    },
    ...(body !== undefined && !['GET', 'HEAD'].includes(options.method || 'POST') ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });
}

function makeLimiter(options = {}) {
  const calls = [];
  const binding = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      if (options.throw) throw new Error('limiter unavailable');
      if (options.httpError) return new Response('{}', { status: 503 });
      return Response.json({
        allowed: options.allowed !== false,
        retryAfterSeconds: options.retryAfterSeconds || 17
      });
    }
  };
  return { binding, calls };
}

function makeDb(initialLicense, options = {}) {
  let license = initialLicense ? { ...initialLicense } : null;
  const calls = [];
  const db = {
    from(table) {
      const state = { table, operation: 'select', filters: [], payload: null, selected: null };
      const query = {
        select(columns) { state.selected = columns; return query; },
        eq(field, value) { state.filters.push(['eq', field, value]); return query; },
        is(field, value) { state.filters.push(['is', field, value]); return query; },
        update(payload) { state.operation = 'update'; state.payload = payload; return query; },
        async maybeSingle() {
          const call = { ...state, mode: 'maybeSingle' };
          calls.push(call);
          if (options.selectError && state.operation === 'select') return { data: null, error: { code: 'DB_DOWN' } };
          if (options.updateError && state.operation === 'update') return { data: null, error: { code: 'DB_DOWN' } };
          if (!license || !state.filters.every(([op, field, value]) => {
            if (op === 'eq') return license[field] === value;
            if (op === 'is') return license[field] === value;
            return false;
          })) return { data: null, error: null };
          if (state.operation === 'update') {
            Object.assign(license, state.payload);
            return { data: state.selected ? { id: license.id } : license, error: null };
          }
          return { data: { ...license }, error: null };
        },
        then(resolve, reject) {
          const call = { ...state, mode: 'await' };
          calls.push(call);
          if (options.updateError && state.operation === 'update') return Promise.resolve({ data: null, error: { code: 'DB_DOWN' } }).then(resolve, reject);
          if (!license || !state.filters.every(([op, field, value]) => op === 'eq' && license[field] === value)) {
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          if (state.operation === 'update') Object.assign(license, state.payload);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  return { db, calls, getLicense: () => license };
}

const activeLicense = {
  id: 'license-1',
  license_key_hash: createHash('sha256').update(key).digest('hex'),
  product_code: 'TIGER-GOLD',
  license_type: 'LIFETIME',
  status: 'ACTIVE',
  expires_at: null,
  bound_mt5_login: null,
  bound_mt5_server: null,
  activated_at: null
};

function handlerFor(db, limiter, now = () => Date.parse('2026-11-18T15:00:00.000Z')) {
  return createBotLicenseHandler({ createClientImpl: () => db, now })({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo', action: 'ACTIVATE' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
}

test('license activation fails closed when rate protection is missing', async () => {
  const { db } = makeDb(activeLicense);
  const response = await createBotLicenseHandler({ createClientImpl: () => db })({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo' }),
    env: envBase
  });
  assert.equal(response.status, 503);
});

test('license endpoint enforces POST and Cloudflare client IP', async () => {
  const { db } = makeDb(activeLicense);
  const limiter = makeLimiter();
  const handler = createBotLicenseHandler({ createClientImpl: () => db });
  const method = await handler({ request: makeRequest({}, { method: 'GET' }), env: { ...envBase, APP_RATE_LIMITER: limiter.binding } });
  assert.equal(method.status, 405);
  const noIp = await handler({ request: new Request('https://preview.example.pages.dev/api/bot-license/activate', { method: 'POST', body: '{}' }), env: { ...envBase, APP_RATE_LIMITER: limiter.binding } });
  assert.equal(noIp.status, 503);
});

test('IP rate limiting runs before license lookup and denies excessive attempts', async () => {
  const { db, calls } = makeDb(activeLicense);
  const limiter = makeLimiter({ allowed: false });
  const response = await createBotLicenseHandler({ createClientImpl: () => db })({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  assert.equal(response.status, 429);
  assert.equal(calls.length, 0);
  assert.equal(limiter.calls.length, 1);
  assert.match(limiter.calls[0].body.key, /^bot-license-ip:/);
});

test('malformed license requests are rejected after IP rate limiting', async () => {
  const { db, calls } = makeDb(activeLicense);
  const limiter = makeLimiter();
  const response = await createBotLicenseHandler({ createClientImpl: () => db })({
    request: makeRequest({ licenseKey: 'bad', mt5Login: 'abc', mt5Server: 'x' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
  assert.equal(limiter.calls.length, 1);
});

test('VERIFY cannot silently activate an unbound license', async () => {
  const { db } = makeDb(activeLicense);
  const limiter = makeLimiter();
  const response = await createBotLicenseHandler({ createClientImpl: () => db })({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo', action: 'VERIFY' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).valid, false);
});

test('ACTIVATE binds once and repeated same-account activation is idempotent', async () => {
  const { db, getLicense } = makeDb(activeLicense);
  const limiter = makeLimiter();
  const handler = createBotLicenseHandler({ createClientImpl: () => db, now: () => Date.parse('2026-11-18T15:00:00.000Z') });
  const first = await handler({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo', action: 'ACTIVATE' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  const second = await handler({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo', action: 'ACTIVATE' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(getLicense().bound_mt5_login, '12345678');
  assert.equal(getLicense().bound_mt5_server, 'Broker-Demo');
  assert.equal(limiter.calls.length, 4);
  assert.doesNotMatch(await second.text(), new RegExp(key));
});

test('a bound license cannot be moved to a different MT5 account or server', async () => {
  const { db } = makeDb({ ...activeLicense, bound_mt5_login: '87654321', bound_mt5_server: 'Other-Demo' });
  const limiter = makeLimiter();
  const response = await createBotLicenseHandler({ createClientImpl: () => db })({
    request: makeRequest({ licenseKey: key, mt5Login: '12345678', mt5Server: 'Broker-Demo' }),
    env: { ...envBase, APP_RATE_LIMITER: limiter.binding }
  });
  assert.equal(response.status, 403);
});

test('expired license is marked EXPIRED and never activated', async () => {
  const { db, getLicense } = makeDb({ ...activeLicense, expires_at: '2026-11-18T14:59:59.000Z' });
  const limiter = makeLimiter();
  const response = await handlerFor(db, limiter);
  assert.equal(response.status, 403);
  assert.equal(getLicense().status, 'EXPIRED');
  assert.equal(getLicense().bound_mt5_login, null);
});

test('database errors fail closed without exposing the license key', async () => {
  const { db } = makeDb(activeLicense, { selectError: true });
  const limiter = makeLimiter();
  const response = await handlerFor(db, limiter);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), new RegExp(key));
});

test('rate limiter failures fail closed', async () => {
  const { db, calls } = makeDb(activeLicense);
  const limiter = makeLimiter({ httpError: true });
  const response = await handlerFor(db, limiter);
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});
