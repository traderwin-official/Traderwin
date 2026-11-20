import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVerifiedDerivAccounts,
  selectUnambiguousAccountId
} from '../lib/deriv-accounts.js';
import {
  createDerivAccountsHandler,
  createDerivSelectAccountHandler
} from '../lib/cloudflare-deriv-accounts.js';

const now = 1800000000000;
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder'
};
const makeRequest = (path, method = 'GET', body, headers = {}) => new Request(
  'https://preview.example.pages.dev' + path,
  {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }
);

function fakeAdmin({ connection, userId = 'user-1', updateResult = null } = {}) {
  const state = { selectedUserId: null, selectedExpiry: null, update: null };
  const client = {
    auth: {
      getUser: async (token) => token === 'valid-session'
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token' } }
    },
    from(table) {
      assert.equal(table, 'deriv_connections');
      return {
        select() {
          const query = {
            eq(field, value) {
              assert.equal(field, 'user_id');
              state.selectedUserId = value;
              return query;
            },
            maybeSingle: async () => ({ data: connection ?? null, error: null })
          };
          return query;
        },
        update(row) {
          state.update = row;
          const query = {
            eq(field, value) {
              if (field === 'user_id') state.selectedUserId = value;
              else if (field === 'token_expires_at') state.selectedExpiry = value;
              else assert.fail('Unexpected update filter: ' + field);
              return query;
            },
            select() { return query; },
            maybeSingle: async () => updateResult || { data: { user_id: userId }, error: null }
          };
          return query;
        }
      };
    }
  };
  return { client, state };
}

test('normalizes only active verified Deriv accounts and never copies provider secrets', () => {
  const accounts = normalizeVerifiedDerivAccounts({
    data: [
      { account_id: 'VRTC1', account_type: 'demo', status: 'active', currency: 'USD', token: 'secret' },
      { account_id: 'CR1', account_type: 'real', status: 'active', currency: 'USD' },
      { account_id: 'OLD1', account_type: 'demo', status: 'disabled' },
      { account_id: 'VRTC1', account_type: 'demo', status: 'active' },
      { account_id: 123, account_type: 'demo', status: 'active' }
    ]
  });
  assert.deepEqual(accounts, [
    { account_id: 'VRTC1', account_type: 'demo', currency: 'USD', status: 'active', group: null },
    { account_id: 'CR1', account_type: 'real', currency: 'USD', status: 'active', group: null }
  ]);
  assert.equal(JSON.stringify(accounts).includes('secret'), false);
});

test('does not silently choose between multiple DEMO accounts', () => {
  assert.equal(selectUnambiguousAccountId([
    { account_id: 'D1', account_type: 'demo', status: 'active' },
    { account_id: 'D2', account_type: 'demo', status: 'active' }
  ], 'demo'), null);
});

test('Deriv account listing requires an authenticated user', async () => {
  const handler = createDerivAccountsHandler();
  const response = await handler({
    request: makeRequest('/api/deriv/accounts'),
    env
  });
  assert.equal(response.status, 401);
});

test('Deriv account listing fails closed when Supabase configuration is missing', async () => {
  const handler = createDerivAccountsHandler();
  const response = await handler({
    request: makeRequest('/api/deriv/accounts', 'GET', undefined, { Authorization: 'Bearer valid-session' }),
    env: {}
  });
  assert.equal(response.status, 503);
});

test('Deriv account listing returns sanitized accounts for only the authenticated user', async () => {
  const connection = {
    deriv_account_id: 'VRTC1',
    token_expires_at: new Date(now + 60000).toISOString(),
    connected_at: new Date(now - 1000).toISOString(),
    accounts: [
      { account_id: 'VRTC1', account_type: 'demo', status: 'active', currency: 'USD', access_token: 'never-return' },
      { account_id: 'CR1', account_type: 'real', status: 'active', currency: 'USD' },
      { account_id: 'OLD1', account_type: 'demo', status: 'disabled' }
    ]
  };
  const fake = fakeAdmin({ connection });
  const handler = createDerivAccountsHandler({
    createClientImpl: () => fake.client,
    now: () => now
  });
  const response = await handler({
    request: makeRequest('/api/deriv/accounts', 'GET', undefined, { Authorization: 'Bearer valid-session' }),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(fake.state.selectedUserId, 'user-1');
  assert.deepEqual(body.accounts.map((account) => account.account_id), ['VRTC1', 'CR1']);
  assert.equal(body.selected_account_id, 'VRTC1');
  assert.equal(body.real_trading_enabled, false);
  assert.equal(JSON.stringify(body).includes('never-return'), false);
  assert.equal(JSON.stringify(body).includes('access_token'), false);
});

test('Deriv account listing rejects expired OAuth authorization', async () => {
  const fake = fakeAdmin({
    connection: { token_expires_at: new Date(now - 1).toISOString(), accounts: [] }
  });
  const handler = createDerivAccountsHandler({
    createClientImpl: () => fake.client,
    now: () => now
  });
  const response = await handler({
    request: makeRequest('/api/deriv/accounts', 'GET', undefined, { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(response.status, 409);
});

test('Deriv account selection accepts only an active verified DEMO account and is user-scoped', async () => {
  const expiry = new Date(now + 60000).toISOString();
  const fake = fakeAdmin({
    connection: {
      token_expires_at: expiry,
      accounts: [
        { account_id: 'VRTC1', account_type: 'demo', status: 'active' },
        { account_id: 'CR1', account_type: 'real', status: 'active' }
      ]
    }
  });
  const handler = createDerivSelectAccountHandler({
    createClientImpl: () => fake.client,
    now: () => now
  });
  const response = await handler({
    request: makeRequest('/api/deriv/select-account', 'POST', { account_id: 'VRTC1' }, { Authorization: 'Bearer valid-session' }),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(fake.state.selectedUserId, 'user-1');
  assert.equal(fake.state.selectedExpiry, expiry);
  assert.deepEqual(Object.keys(fake.state.update).sort(), ['demo_account_id', 'deriv_account_id', 'updated_at']);
  assert.equal(fake.state.update.demo_account_id, 'VRTC1');
  assert.equal(fake.state.update.deriv_account_id, 'VRTC1');
  assert.equal(body.selected_account_id, 'VRTC1');
  assert.match(body.message, /REAL trading remains locked/);
});

test('Deriv account selection rejects REAL accounts and does not write', async () => {
  const fake = fakeAdmin({
    connection: {
      token_expires_at: new Date(now + 60000).toISOString(),
      accounts: [{ account_id: 'CR1', account_type: 'real', status: 'active' }]
    }
  });
  const handler = createDerivSelectAccountHandler({
    createClientImpl: () => fake.client,
    now: () => now
  });
  const response = await handler({
    request: makeRequest('/api/deriv/select-account', 'POST', { account_id: 'CR1' }, { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(response.status, 403);
  assert.equal(fake.state.update, null);
});

test('Deriv account selection rejects expired authorization and stale compare-and-set updates', async () => {
  const expired = fakeAdmin({
    connection: { token_expires_at: new Date(now - 1).toISOString(), accounts: [] }
  });
  const expiredHandler = createDerivSelectAccountHandler({
    createClientImpl: () => expired.client,
    now: () => now
  });
  const expiredResponse = await expiredHandler({
    request: makeRequest('/api/deriv/select-account', 'POST', { account_id: 'D1' }, { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(expiredResponse.status, 409);

  const expiry = new Date(now + 60000).toISOString();
  const stale = fakeAdmin({
    connection: { token_expires_at: expiry, accounts: [{ account_id: 'D1', account_type: 'demo', status: 'active' }] },
    updateResult: { data: null, error: null }
  });
  const staleHandler = createDerivSelectAccountHandler({
    createClientImpl: () => stale.client,
    now: () => now
  });
  const staleResponse = await staleHandler({
    request: makeRequest('/api/deriv/select-account', 'POST', { account_id: 'D1' }, { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(staleResponse.status, 409);
});

test('Deriv account selection rejects malformed account IDs', async () => {
  const handler = createDerivSelectAccountHandler();
  const response = await handler({
    request: makeRequest('/api/deriv/select-account', 'POST', { account_id: ' ' }, { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(response.status, 400);
});
