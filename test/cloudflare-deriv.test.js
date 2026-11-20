import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createDerivStartHandler,
  createDerivCallbackHandler,
  createDerivStatusHandler,
  createDerivDisconnectHandler,
  createSignedOAuthCookie,
  verifySignedOAuthCookie
} from '../lib/cloudflare-deriv.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder',
  DERIV_CLIENT_ID: 'test-client-id',
  DERIV_REDIRECT_URI: 'https://preview.example.pages.dev/api/deriv/callback',
  DERIV_OAUTH_SECRET: 'test-oauth-secret',
  TOKEN_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4)
};

const request = (path, method = 'GET', headers = {}) =>
  new Request('https://preview.example.pages.dev' + path, { method, headers });

function authenticatedClient(userId = 'user-123') {
  return {
    auth: {
      getUser: async (token) => token === 'valid-session'
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token' } }
    }
  };
}

test('Deriv OAuth start fails closed when required environment settings are missing', async () => {
  const handler = createDerivStartHandler();
  const response = await handler({ request: request('/api/deriv/start', 'POST'), env: {} });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Deriv OAuth start requires a Supabase bearer session', async () => {
  const handler = createDerivStartHandler();
  const response = await handler({
    request: request('/api/deriv/start', 'POST'),
    env
  });
  assert.equal(response.status, 401);
});

test('Deriv OAuth start creates a signed, short-lived PKCE session for the authenticated user', async () => {
  const handler = createDerivStartHandler({ createClientImpl: () => authenticatedClient() });
  const response = await handler({
    request: request('/api/deriv/start', 'POST', { Authorization: 'Bearer valid-session' }),
    env
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  const authorizationUrl = new URL(body.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://auth.deriv.com');
  assert.equal(authorizationUrl.searchParams.get('client_id'), env.DERIV_CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), env.DERIV_REDIRECT_URI);
  assert.equal(authorizationUrl.searchParams.get('scope'), 'trade account_manage');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizationUrl.searchParams.get('code_challenge'));

  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/deriv/);
  assert.match(cookie, /Max-Age=600/);
  const cookieValue = cookie.match(/deriv_oauth=([^;]+)/)[1];
  const session = verifySignedOAuthCookie(cookieValue, env.DERIV_OAUTH_SECRET);
  assert.equal(session.userId, 'user-123');
  assert.equal(session.state, authorizationUrl.searchParams.get('state'));
  assert.ok(session.expires > Date.now());
});

test('Deriv OAuth signed state rejects tampering and expired sessions', () => {
  const signed = createSignedOAuthCookie({
    userId: 'user-123',
    state: 'state-123',
    verifier: 'verifier-123',
    expires: 2000
  }, env.DERIV_OAUTH_SECRET);
  assert.ok(verifySignedOAuthCookie(signed, env.DERIV_OAUTH_SECRET, crypto, 1000));
  assert.equal(verifySignedOAuthCookie(signed + 'tampered', env.DERIV_OAUTH_SECRET, crypto, 1000), null);
  assert.equal(verifySignedOAuthCookie(signed, env.DERIV_OAUTH_SECRET, crypto, 2000), null);
});

test('Deriv callback rejects a missing OAuth cookie and clears it', async () => {
  const handler = createDerivCallbackHandler();
  const response = await handler({
    request: request('/api/deriv/callback?code=abc&state=state-123'),
    env
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('deriv'), 'error');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('Deriv callback rejects a mismatched state before contacting Deriv', async () => {
  let fetchCalls = 0;
  const cookieValue = createSignedOAuthCookie({
    userId: 'user-123',
    state: 'expected-state',
    verifier: 'pkce-verifier',
    expires: Date.now() + 600000
  }, env.DERIV_OAUTH_SECRET);
  const handler = createDerivCallbackHandler({ fetchImpl: async () => { fetchCalls += 1; throw new Error('unexpected fetch'); } });
  const response = await handler({
    request: new Request('https://preview.example.pages.dev/api/deriv/callback?code=abc&state=wrong-state', {
      headers: { Cookie: 'deriv_oauth=' + cookieValue }
    }),
    env
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('deriv'), 'error');
  assert.equal(fetchCalls, 0);
});

test('Deriv callback verifies demo account, encrypts token and saves only to the signed-in user row', async () => {
  const now = 1800000000000;
  const cookieValue = createSignedOAuthCookie({
    userId: 'user-456',
    state: 'state-456',
    verifier: 'pkce-verifier-456',
    expires: now + 600000
  }, env.DERIV_OAUTH_SECRET);
  const requests = [];
  let savedRow;
  let savedOptions;
  const fakeAdmin = {
    from: (table) => {
      assert.equal(table, 'deriv_connections');
      return {
        upsert: async (row, options) => {
          savedRow = row;
          savedOptions = options;
          return { error: null };
        }
      };
    }
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === 'https://auth.deriv.com/oauth2/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('code'), 'auth-code');
      assert.equal(form.get('code_verifier'), 'pkce-verifier-456');
      assert.equal(form.get('redirect_uri'), env.DERIV_REDIRECT_URI);
      return Response.json({ access_token: 'deriv-token-test-only', expires_in: 3600 });
    }
    if (url === 'https://api.derivws.com/trading/v1/options/accounts') {
      assert.equal(options.headers.Authorization, 'Bearer deriv-token-test-only');
      return Response.json({ data: [
        { account_id: 'VRTC12345', account_type: 'demo', status: 'active' },
        { account_id: 'CR12345', account_type: 'real', status: 'active' }
      ] });
    }
    throw new Error('Unexpected external URL');
  };
  const handler = createDerivCallbackHandler({
    createClientImpl: () => fakeAdmin,
    fetchImpl,
    now: () => now
  });
  const response = await handler({
    request: new Request('https://preview.example.pages.dev/api/deriv/callback?code=auth-code&state=state-456', {
      headers: { Cookie: 'deriv_oauth=' + cookieValue }
    }),
    env
  });

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('deriv'), 'connected');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(requests.length, 2);
  assert.equal(savedRow.user_id, 'user-456');
  assert.equal(savedRow.demo_account_id, 'VRTC12345');
  assert.equal(savedRow.real_account_id, 'CR12345');
  assert.equal(savedRow.deriv_account_id, 'VRTC12345');
  assert.deepEqual(savedRow.accounts, [
    { account_id: 'VRTC12345', account_type: 'demo', currency: null, status: 'active', group: null },
    { account_id: 'CR12345', account_type: 'real', currency: null, status: 'active', group: null }
  ]);
  assert.equal(savedRow.token_type, 'Bearer');
  assert.deepEqual(savedRow.requested_scopes, ['trade', 'account_manage']);
  assert.equal(savedRow.connected_at, new Date(now).toISOString());
  assert.equal(JSON.stringify(savedRow.accounts).includes('deriv-token-test-only'), false);
  assert.equal(savedOptions.onConflict, 'user_id');
  assert.notEqual(savedRow.encrypted_access_token, 'deriv-token-test-only');
  const [ivHex, tagHex, cipherHex] = savedRow.encrypted_access_token.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex'),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
  assert.equal(decrypted, 'deriv-token-test-only');
  assert.equal(savedRow.token_expires_at, new Date(now + 3600000).toISOString());
});

test('Deriv callback refuses to save a connection without an active demo account', async () => {
  const now = 1800000000000;
  const cookieValue = createSignedOAuthCookie({
    userId: 'user-789',
    state: 'state-789',
    verifier: 'pkce-verifier',
    expires: now + 600000
  }, env.DERIV_OAUTH_SECRET);
  let saved = false;
  const fakeAdmin = {
    from: () => ({ upsert: async () => { saved = true; return { error: null }; } })
  };
  const handler = createDerivCallbackHandler({
    createClientImpl: () => fakeAdmin,
    now: () => now,
    fetchImpl: async (url) => url === 'https://auth.deriv.com/oauth2/token'
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json({ data: [{ account_id: 'CR123', account_type: 'real', status: 'active' }] })
  });
  const response = await handler({
    request: new Request('https://preview.example.pages.dev/api/deriv/callback?code=abc&state=state-789', {
      headers: { Cookie: 'deriv_oauth=' + cookieValue }
    }),
    env
  });
  assert.equal(new URL(response.headers.get('location')).searchParams.get('deriv'), 'error');
  assert.equal(saved, false);
});

test('Deriv status returns only account metadata for the authenticated user', async () => {
  const now = 1800000000000;
  const fakeAdmin = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-status' } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: (field, userId) => {
          assert.equal(field, 'user_id');
          assert.equal(userId, 'user-status');
          return { maybeSingle: async () => ({
            data: {
              demo_account_id: 'VRTC999',
              real_account_id: 'CR999',
              token_expires_at: new Date(now + 100000).toISOString(),
              updated_at: new Date(now - 1000).toISOString()
            },
            error: null
          }) };
        }
      })
    })
  };
  const handler = createDerivStatusHandler({ createClientImpl: () => fakeAdmin, now: () => now });
  const response = await handler({
    request: request('/api/deriv/status', 'GET', { Authorization: 'Bearer valid-session' }),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.demoAccountId, 'VRTC999');
  assert.equal(body.realAccountId, 'CR999');
  assert.equal('encrypted_access_token' in body, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Deriv status rejects unauthenticated requests', async () => {
  const handler = createDerivStatusHandler();
  const response = await handler({ request: request('/api/deriv/status'), env });
  assert.equal(response.status, 401);
});

test('Deriv disconnect deletes only the authenticated user connection', async () => {
  let deletedUserId;
  const fakeAdmin = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-delete' } }, error: null }) },
    from: (table) => {
      assert.equal(table, 'deriv_connections');
      return {
        delete: () => ({
          eq: async (field, userId) => {
            assert.equal(field, 'user_id');
            deletedUserId = userId;
            return { error: null };
          }
        })
      };
    }
  };
  const handler = createDerivDisconnectHandler({ createClientImpl: () => fakeAdmin });
  const response = await handler({
    request: request('/api/deriv/disconnect', 'POST', { Authorization: 'Bearer valid-session' }),
    env
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true });
  assert.equal(deletedUserId, 'user-delete');
});
