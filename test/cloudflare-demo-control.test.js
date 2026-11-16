import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoControlHandler } from '../lib/cloudflare-demo-control.js';

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder' };

function request(body, token = 'valid-session', method = 'POST') {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request('https://preview.example.pages.dev/api/bots/demo/control', {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

function fakeDb(options = {}) {
  const calls = [];
  const userId = options.userId || 'user-123';
  const resolver = options.resolve || (() => ({ data: null, error: null }));
  const db = {
    auth: {
      getUser: async token => token === 'valid-session'
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: 'invalid session' } }
    },
    from(table) {
      const state = { table, operation: 'select', filters: [], selected: null, payload: null, order: null, limit: null };
      const query = {
        select(columns) { state.selected = columns; return query; },
        eq(field, value) { state.filters.push(['eq', field, value]); return query; },
        in(field, values) { state.filters.push(['in', field, values]); return query; },
        order(field, config) { state.order = [field, config]; return query; },
        limit(value) { state.limit = value; return query; },
        insert(payload) { state.operation = 'insert'; state.payload = payload; return query; },
        update(payload) { state.operation = 'update'; state.payload = payload; return query; },
        maybeSingle() { calls.push({ ...state, mode: 'maybeSingle' }); return Promise.resolve(resolver(state, 'maybeSingle', calls.length - 1)); },
        single() { calls.push({ ...state, mode: 'single' }); return Promise.resolve(resolver(state, 'single', calls.length - 1)); },
        then(resolve, reject) { calls.push({ ...state, mode: 'await' }); return Promise.resolve(resolver(state, 'await', calls.length - 1)).then(resolve, reject); }
      };
      return query;
    }
  };
  return { db, calls };
}

const profile = { account_mode: 'DEMO', max_risk_per_trade_pct: 1, max_daily_loss_pct: 3 };
const settings = {
  id: 'setting-1', broker: 'DERIV', instrument: 'XAUUSD', account_mode: 'DEMO',
  timeframe: 'M15', strategy: 'MULTI_CONFIRMATION_V1', max_risk_per_trade_pct: 0.8
};

test('DEMO control fails closed when server configuration is missing', async () => {
  const handler = createDemoControlHandler();
  const response = await handler({ request: request({ action: 'STATUS' }), env: {} });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('DEMO control requires POST and an authenticated Supabase bearer session', async () => {
  const handler = createDemoControlHandler({ createClientImpl: () => fakeDb().db });
  assert.equal((await handler({ request: new Request('https://preview.example.pages.dev/api/bots/demo/control', { method: 'GET' }), env })).status, 405);
  assert.equal((await handler({ request: request({ action: 'STATUS' }, null), env })).status, 401);
  assert.equal((await handler({ request: request({ action: 'STATUS' }, 'expired'), env })).status, 401);
});

test('DEMO control rejects invalid JSON and unknown actions', async () => {
  const handler = createDemoControlHandler({ createClientImpl: () => fakeDb().db });
  const malformed = await handler({
    request: new Request('https://preview.example.pages.dev/api/bots/demo/control', {
      method: 'POST', headers: { Authorization: 'Bearer valid-session' }, body: '{bad'
    }), env
  });
  assert.equal(malformed.status, 400);
  assert.equal((await handler({ request: request({ action: 'CLOSE_ALL' }), env })).status, 400);
});

test('STATUS returns no session without exposing another user data', async () => {
  const { db, calls } = fakeDb({
    resolve: state => {
      assert.equal(state.table, 'demo_bot_sessions');
      assert.ok(state.filters.some(([op, field, value]) => op === 'eq' && field === 'user_id' && value === 'user-123'));
      assert.ok(state.filters.some(([op, field, value]) => op === 'eq' && field === 'account_mode' && value === 'DEMO'));
      return { data: null, error: null };
    }
  });
  const response = await createDemoControlHandler({ createClientImpl: () => db })({
    request: request({ action: 'STATUS' }), env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session, null);
  assert.equal(body.openTrade, null);
  assert.equal(calls.length, 1);
});

test('START rejects REAL profile mode and emergency-stop state', async () => {
  const realDb = fakeDb({ resolve: state => state.table === 'trader_profiles'
    ? { data: { ...profile, account_mode: 'REAL' }, error: null }
    : { data: null, error: null } }).db;
  const realResponse = await createDemoControlHandler({ createClientImpl: () => realDb })({
    request: request({ action: 'START' }), env
  });
  assert.equal(realResponse.status, 403);

  const stoppedDb = fakeDb({ resolve: state => {
    if (state.table === 'trader_profiles') return { data: profile, error: null };
    if (state.table === 'bot_settings') return { data: settings, error: null };
    if (state.table === 'bot_emergency_controls') return { data: { kill_switch_active: true }, error: null };
    return { data: null, error: null };
  } }).db;
  const stoppedResponse = await createDemoControlHandler({ createClientImpl: () => stoppedDb })({
    request: request({ action: 'START' }), env
  });
  assert.equal(stoppedResponse.status, 403);
});

test('START rejects unsupported broker, strategy and timeframe', async () => {
  const build = override => fakeDb({ resolve: state => {
    if (state.table === 'trader_profiles') return { data: profile, error: null };
    if (state.table === 'bot_settings') return { data: { ...settings, ...override }, error: null };
    return { data: null, error: null };
  } }).db;
  const brokerResponse = await createDemoControlHandler({ createClientImpl: () => build({ broker: 'MT5' }) })({
    request: request({ action: 'START' }), env
  });
  assert.equal(brokerResponse.status, 403);
  const strategyResponse = await createDemoControlHandler({ createClientImpl: () => build({ strategy: 'MANUAL_REVIEW' }) })({
    request: request({ action: 'START' }), env
  });
  assert.equal(strategyResponse.status, 409);
  const timeframeResponse = await createDemoControlHandler({ createClientImpl: () => build({ timeframe: 'M1' }) })({
    request: request({ action: 'START' }), env
  });
  assert.equal(timeframeResponse.status, 409);
});

test('START creates a DEMO-only session with the tightest risk limits', async () => {
  const { db, calls } = fakeDb({
    resolve: state => {
      if (state.table === 'trader_profiles') return { data: profile, error: null };
      if (state.table === 'bot_settings') return { data: settings, error: null };
      if (state.table === 'bot_emergency_controls') return { data: { kill_switch_active: false }, error: null };
      if (state.table === 'bot_mode_profiles') return { data: { max_risk_per_trade_pct: 0.6, max_daily_loss_pct: 2 }, error: null };
      if (state.table === 'demo_bot_sessions' && state.mode === 'maybeSingle') {
        if (state.filters.some(([op, field, value]) => op === 'eq' && field === 'status' && value === 'RISK_LOCKED')) return { data: null, error: null };
        return { data: null, error: null };
      }
      if (state.table === 'demo_bot_trades' && state.mode === 'await') return { data: [], error: null };
      if (state.table === 'demo_bot_sessions' && state.mode === 'single') {
        assert.equal(state.payload.account_mode, 'DEMO');
        assert.equal(state.payload.status, 'RUNNING');
        assert.equal(state.payload.max_risk_per_trade_pct, 0.6);
        assert.equal(state.payload.max_daily_loss_pct, 2);
        return { data: { id: 'session-1', status: 'RUNNING', current_balance: 10000, started_at: '2026-11-16T10:00:00.000Z' }, error: null };
      }
      return { data: null, error: null };
    }
  });
  const response = await createDemoControlHandler({ createClientImpl: () => db, now: () => Date.parse('2026-11-16T10:00:00.000Z') })({
    request: request({ action: 'START' }), env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session.id, 'session-1');
  assert.equal(body.session.instrument, 'XAUUSD');
  assert.match(body.message, /no broker orders are sent/i);
  assert.ok(calls.some(call => call.table === 'demo_bot_sessions' && call.operation === 'insert'));
});

test('START is idempotent when a DEMO session is already running', async () => {
  const { db, calls } = fakeDb({ resolve: state => {
    if (state.table === 'trader_profiles') return { data: profile, error: null };
    if (state.table === 'bot_settings') return { data: settings, error: null };
    if (state.table === 'bot_emergency_controls') return { data: { kill_switch_active: false }, error: null };
    if (state.table === 'bot_mode_profiles') return { data: null, error: null };
    if (state.table === 'demo_bot_sessions' && state.mode === 'maybeSingle' && state.filters.some(([op, field, value]) => op === 'eq' && field === 'status' && value === 'RISK_LOCKED')) return { data: null, error: null };
    if (state.table === 'demo_bot_sessions' && state.mode === 'maybeSingle') return { data: { id: 'session-live', status: 'RUNNING', current_balance: 10000 }, error: null };
    return { data: null, error: null };
  } });
  const response = await createDemoControlHandler({ createClientImpl: () => db })({
    request: request({ action: 'START' }), env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session.id, 'session-live');
  assert.equal(calls.some(call => call.table === 'demo_bot_sessions' && call.operation === 'insert'), false);
});

test('STOP pauses a session with an open BOT position without closing it', async () => {
  const { db, calls } = fakeDb({ resolve: state => {
    if (state.table === 'demo_bot_sessions' && state.operation === 'update') return { data: { id: 'session-1', status: 'PAUSED' }, error: null };
    if (state.table === 'demo_bot_sessions' && state.mode === 'maybeSingle') return { data: { id: 'session-1', bot_setting_id: 'setting-1' }, error: null };
    if (state.table === 'demo_bot_trades') return { data: { id: 'trade-1', trade_source: 'BOT' }, error: null };
    return { data: { id: 'session-1', status: 'PAUSED' }, error: null };
  } });
  const response = await createDemoControlHandler({ createClientImpl: () => db })({
    request: request({ action: 'STOP' }), env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session.status, 'PAUSED');
  assert.match(body.message, /continue managing your existing BOT position/i);
  assert.equal(calls.some(call => call.table === 'demo_bot_trades' && call.operation === 'update'), false);
});

test('STOP marks the session STOPPED when there is no BOT-owned open position', async () => {
  const { db } = fakeDb({ resolve: state => {
    if (state.table === 'demo_bot_sessions' && state.mode === 'maybeSingle' && state.operation === 'select') return { data: { id: 'session-2', bot_setting_id: 'setting-2' }, error: null };
    if (state.table === 'demo_bot_trades') return { data: null, error: null };
    if (state.table === 'demo_bot_sessions' && state.operation === 'update') return { data: { id: 'session-2', status: 'STOPPED' }, error: null };
    return { data: null, error: null };
  } });
  const response = await createDemoControlHandler({ createClientImpl: () => db })({
    request: request({ action: 'STOP' }), env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.session.status, 'STOPPED');
});

test('database failures fail closed instead of starting or stopping a session', async () => {
  const startDb = fakeDb({ resolve: state => state.table === 'trader_profiles'
    ? { data: null, error: { message: 'db down' } }
    : { data: null, error: null } }).db;
  const startResponse = await createDemoControlHandler({ createClientImpl: () => startDb })({
    request: request({ action: 'START' }), env
  });
  assert.equal(startResponse.status, 503);

  const stopDb = fakeDb({ resolve: state => state.table === 'demo_bot_sessions'
    ? { data: null, error: { message: 'db down' } }
    : { data: null, error: null } }).db;
  const stopResponse = await createDemoControlHandler({ createClientImpl: () => stopDb })({
    request: request({ action: 'STOP' }), env
  });
  assert.equal(stopResponse.status, 503);
});
