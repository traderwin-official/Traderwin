import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmergencyControlHandler
} from '../lib/cloudflare-emergency-control.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder'
};

function request(path, method = 'GET', token = 'valid-session', body = null) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== null) headers['Content-Type'] = 'application/json';
  return new Request('https://preview.example.pages.dev' + path, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {})
  });
}

function fakeClient(options = {}) {
  const calls = [];
  const userId = options.userId || 'user-123';
  const db = {
    auth: {
      getUser: async token => token === 'valid-session'
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token' } }
    },
    from(table) {
      calls.push({ table });
      if (table === 'broker_connections') {
        const query = {
          select(columns) { calls.push({ table, select: columns }); return query; },
          eq(field, value) { calls.push({ table, eq: [field, value] }); return query; },
          maybeSingle: async () => ({
            data: options.connection ?? null,
            error: options.connectionError ?? null
          })
        };
        return query;
      }
      if (table === 'bot_emergency_controls') {
        const query = {
          select(columns) { calls.push({ table, select: columns }); return query; },
          match(key) { calls.push({ table, match: key }); return query; },
          maybeSingle: async () => ({
            data: options.control ?? null,
            error: options.controlError ?? null
          }),
          upsert(row, config) {
            calls.push({ table, upsert: row, config });
            return {
              select(columns) {
                calls.push({ table, select: columns });
                return {
                  single: async () => ({
                    data: options.upsertError ? null : {
                      kill_switch_active: row.kill_switch_active,
                      reason: row.reason,
                      changed_at: row.changed_at
                    },
                    error: options.upsertError ?? null
                  })
                };
              }
            };
          }
        };
        return query;
      }
      if (table === 'bot_activity') {
        return {
          insert: async row => {
            calls.push({ table, insert: row });
            return { error: options.activityError ?? null };
          }
        };
      }
      throw new Error('Unexpected table: ' + table);
    }
  };
  return { db, calls };
}

const demoInput = {
  accountMode: 'DEMO',
  broker: 'DERIV',
  accountRef: 'DEMO:user-123',
  action: 'STATUS'
};

test('emergency control fails closed when Supabase server configuration is missing', async () => {
  const handler = createEmergencyControlHandler('GET');
  const response = await handler({
    request: request('/api/bots/emergency/control'),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('emergency control requires a bearer session and validates the user', async () => {
  const handler = createEmergencyControlHandler('GET', {
    createClientImpl: () => fakeClient().db
  });
  const missing = await handler({
    request: request('/api/bots/emergency/control', 'GET', null),
    env
  });
  assert.equal(missing.status, 401);

  const invalid = await handler({
    request: request('/api/bots/emergency/control', 'GET', 'expired'),
    env
  });
  assert.equal(invalid.status, 401);
});

test('emergency control rejects invalid account scope and unsupported actions', async () => {
  const { db } = fakeClient();
  const handler = createEmergencyControlHandler('POST', { createClientImpl: () => db });
  const badScope = await handler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      ...demoInput,
      accountRef: 'DEMO:another-user'
    }),
    env
  });
  assert.equal(badScope.status, 403);

  const badAction = await handler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      ...demoInput,
      action: 'CLOSE_ALL'
    }),
    env
  });
  assert.equal(badAction.status, 400);
});

test('REAL emergency controls require an owner-matched verified connection', async () => {
  const { db } = fakeClient({ connection: null });
  const handler = createEmergencyControlHandler('POST', { createClientImpl: () => db });
  const response = await handler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      accountMode: 'REAL',
      broker: 'MT5',
      accountRef: 'broker-account-9',
      action: 'STOP_ENTRIES'
    }),
    env
  });
  assert.equal(response.status, 403);
});

test('REAL emergency control checks connected status, verification and account mode', async () => {
  const { db, calls } = fakeClient({
    connection: {
      external_account_id: 'broker-account-9',
      connection_status: 'CONNECTED',
      verified_at: '2026-11-16T10:00:00.000Z',
      account_mode: 'REAL'
    }
  });
  const handler = createEmergencyControlHandler('GET', { createClientImpl: () => db });
  const response = await handler({
    request: request('/api/bots/emergency/control?accountMode=REAL&broker=MT5&accountRef=broker-account-9'),
    env
  });
  assert.equal(response.status, 200);
  assert.ok(calls.some(call => call.table === 'broker_connections' && call.eq?.[1] === 'broker-account-9'));
});

test('GET emergency status is read-only and scoped to the authenticated DEMO account', async () => {
  const { db, calls } = fakeClient({
    control: {
      kill_switch_active: true,
      reason: 'USER_EMERGENCY_STOP',
      changed_at: '2026-11-16T10:00:00.000Z'
    }
  });
  const handler = createEmergencyControlHandler('GET', { createClientImpl: () => db });
  const response = await handler({
    request: request('/api/bots/emergency/control?' + new URLSearchParams(demoInput)),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.killSwitchActive, true);
  assert.equal(body.accountMode, 'DEMO');
  assert.match(body.note, /does not close open positions/i);
  assert.ok(calls.some(call => call.table === 'bot_emergency_controls' &&
    call.match?.user_id === 'user-123' &&
    call.match?.broker_account_ref === 'DEMO:user-123'));
  assert.equal(calls.some(call => call.table === 'bot_activity'), false);
});

test('POST STOP_ENTRIES persists the latch and records an audit event', async () => {
  const { db, calls } = fakeClient();
  const handler = createEmergencyControlHandler('POST', { createClientImpl: () => db });
  const response = await handler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      ...demoInput,
      action: 'STOP_ENTRIES'
    }),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.killSwitchActive, true);
  const write = calls.find(call => call.table === 'bot_emergency_controls' && call.upsert);
  assert.equal(write.upsert.kill_switch_active, true);
  assert.equal(write.upsert.reason, 'USER_EMERGENCY_STOP');
  assert.equal(write.config.onConflict, 'user_id,account_mode,broker,broker_account_ref');
  assert.ok(calls.some(call => call.table === 'bot_activity' && call.insert.event_type === 'STOP_REQUESTED'));
  assert.match(body.note, /Existing positions remain open/i);
});

test('POST CLEAR_STOP only clears the entry latch and does not authorize execution', async () => {
  const { db, calls } = fakeClient();
  const handler = createEmergencyControlHandler('POST', { createClientImpl: () => db });
  const response = await handler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      ...demoInput,
      action: 'CLEAR_STOP'
    }),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.killSwitchActive, false);
  const write = calls.find(call => call.table === 'bot_emergency_controls' && call.upsert);
  assert.equal(write.upsert.kill_switch_active, false);
  assert.equal(write.upsert.reason, null);
  assert.match(body.note, /must still pass all connection, quote, risk and execution checks/i);
});

test('missing emergency-control schema and failed writes return service errors', async () => {
  const statusClient = fakeClient({ controlError: { message: 'missing table' } }).db;
  const statusHandler = createEmergencyControlHandler('GET', { createClientImpl: () => statusClient });
  const statusResponse = await statusHandler({
    request: request('/api/bots/emergency/control?' + new URLSearchParams(demoInput)),
    env
  });
  assert.equal(statusResponse.status, 503);

  const writeClient = fakeClient({ upsertError: { message: 'write failed' } }).db;
  const writeHandler = createEmergencyControlHandler('POST', { createClientImpl: () => writeClient });
  const writeResponse = await writeHandler({
    request: request('/api/bots/emergency/control', 'POST', 'valid-session', {
      ...demoInput,
      action: 'STOP_ENTRIES'
    }),
    env
  });
  assert.equal(writeResponse.status, 503);
});

test('malformed JSON is rejected without changing the emergency latch', async () => {
  const { db, calls } = fakeClient();
  const handler = createEmergencyControlHandler('POST', { createClientImpl: () => db });
  const response = await handler({
    request: new Request('https://preview.example.pages.dev/api/bots/emergency/control', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-session', 'Content-Type': 'application/json' },
      body: '{invalid'
    }),
    env
  });
  assert.equal(response.status, 400);
  assert.equal(calls.some(call => call.table === 'bot_emergency_controls' && call.upsert), false);
});
