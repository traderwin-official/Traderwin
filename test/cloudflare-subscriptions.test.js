import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionStatusHandler } from '../lib/cloudflare-subscriptions.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder'
};
const now = Date.parse('2026-11-15T12:00:00.000Z');

function request(token = 'valid-session', method = 'GET') {
  return new Request('https://preview.example.pages.dev/api/subscriptions/status', {
    method,
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  });
}

function fakeAdmin(subscription, authValid = true) {
  return {
    auth: {
      getUser: async () => authValid
        ? { data: { user: { id: 'user-subscription' } }, error: null }
        : { data: { user: null }, error: { message: 'invalid session' } }
    },
    from: (table) => {
      assert.equal(table, 'user_subscriptions');
      return {
        select: (fields) => {
          assert.equal(fields, 'service_code,status,starts_at,ends_at,payment_order_id');
          return {
            eq: (field, value) => {
              assert.equal(field, 'user_id');
              assert.equal(value, 'user-subscription');
              return {
                eq: (secondField, secondValue) => {
                  assert.equal(secondField, 'service_code');
                  assert.equal(secondValue, 'REAL_TRADING');
                  return {
                    maybeSingle: async () => ({ data: subscription, error: null })
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('subscription status fails closed without Supabase configuration', async () => {
  const handler = createSubscriptionStatusHandler();
  const response = await handler({ request: request(), env: {} });
  assert.equal(response.status, 503);
});

test('subscription status requires a bearer session', async () => {
  const handler = createSubscriptionStatusHandler();
  const response = await handler({ request: request(null), env });
  assert.equal(response.status, 401);
});

test('subscription status rejects invalid Supabase sessions', async () => {
  const handler = createSubscriptionStatusHandler({ createClientImpl: () => fakeAdmin(null, false) });
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 401);
});

test('active subscription is reported without authorizing REAL execution', async () => {
  const handler = createSubscriptionStatusHandler({
    createClientImpl: () => fakeAdmin({
      service_code: 'REAL_TRADING',
      status: 'ACTIVE',
      starts_at: '2026-11-01T00:00:00.000Z',
      ends_at: '2026-12-01T00:00:00.000Z',
      payment_order_id: 'order-123'
    }),
    now: () => now
  });
  const response = await handler({ request: request(), env });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.status, 'ACTIVE');
  assert.equal(body.renewalMode, 'MANUAL');
  assert.equal(body.realExecutionAuthorized, false);
});

test('expired ACTIVE subscription is reported as EXPIRED', async () => {
  const handler = createSubscriptionStatusHandler({
    createClientImpl: () => fakeAdmin({
      service_code: 'REAL_TRADING',
      status: 'ACTIVE',
      ends_at: '2026-11-14T23:59:59.000Z'
    }),
    now: () => now
  });
  const body = await (await handler({ request: request(), env })).json();
  assert.equal(body.status, 'EXPIRED');
  assert.equal(body.active, false);
  assert.equal(body.realExecutionAuthorized, false);
});

test('missing subscription keeps DEMO free and REAL execution locked', async () => {
  const handler = createSubscriptionStatusHandler({
    createClientImpl: () => fakeAdmin(null),
    now: () => now
  });
  const body = await (await handler({ request: request(), env })).json();
  assert.equal(body.status, 'NOT_PURCHASED');
  assert.equal(body.active, false);
  assert.equal(body.realExecutionAuthorized, false);
});

test('subscription status rejects non-GET methods', async () => {
  const handler = createSubscriptionStatusHandler();
  const response = await handler({ request: request('valid-session', 'POST'), env });
  assert.equal(response.status, 405);
});
