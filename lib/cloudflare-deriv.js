import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createClient } from '@supabase/supabase-js';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache'
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

function adminClient(createClientImpl, env) {
  return createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function createSignedOAuthCookie(session, secret, cryptoImpl = crypto) {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const signature = cryptoImpl.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

export function verifySignedOAuthCookie(cookieValue, secret, cryptoImpl = crypto, now = Date.now()) {
  if (typeof cookieValue !== 'string' || !secret) return null;
  const separator = cookieValue.lastIndexOf('.');
  if (separator < 1) return null;

  const payload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = cryptoImpl.createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !cryptoImpl.timingSafeEqual(received, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      !session ||
      typeof session.userId !== 'string' ||
      !session.userId ||
      typeof session.state !== 'string' ||
      !session.state ||
      typeof session.verifier !== 'string' ||
      !session.verifier ||
      !Number.isFinite(session.expires) ||
      session.expires <= now
    ) return null;
    return session;
  } catch {
    return null;
  }
}

export function encryptDerivToken(token, encryptionKey, cryptoImpl = crypto) {
  if (typeof encryptionKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('Invalid token encryption key configuration.');
  }
  if (typeof token !== 'string' || !token) throw new Error('Invalid Deriv token.');

  const key = Buffer.from(encryptionKey, 'hex');
  const iv = cryptoImpl.randomBytes(12);
  const cipher = cryptoImpl.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function clearOAuthCookie() {
  return 'deriv_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=0';
}

function readOAuthCookie(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)deriv_oauth=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function createDerivStartHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const cryptoImpl = dependencies.cryptoImpl || crypto;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }

    if (
      !env.DERIV_CLIENT_ID ||
      !env.DERIV_REDIRECT_URI ||
      !env.DERIV_OAUTH_SECRET ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return jsonResponse({ error: 'Server configuration incomplete.' }, 503);
    }

    const accessToken = bearerToken(request);
    if (!accessToken) return jsonResponse({ error: 'Sign in is required.' }, 401);

    try {
      const supabase = adminClient(createClientImpl, env);
      const { data, error } = await supabase.auth.getUser(accessToken);
      if (error || !data?.user?.id) {
        return jsonResponse({ error: 'Your login session is invalid.' }, 401);
      }

      const verifier = cryptoImpl.randomBytes(32).toString('base64url');
      const state = cryptoImpl.randomBytes(32).toString('hex');
      const challenge = cryptoImpl.createHash('sha256').update(verifier).digest('base64url');
      const session = {
        verifier,
        state,
        userId: data.user.id,
        expires: Date.now() + 600000
      };
      const cookieValue = createSignedOAuthCookie(session, env.DERIV_OAUTH_SECRET, cryptoImpl);
      const authorizationUrl = new URL('https://auth.deriv.com/oauth2/auth');
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('client_id', env.DERIV_CLIENT_ID);
      authorizationUrl.searchParams.set('redirect_uri', env.DERIV_REDIRECT_URI);
      authorizationUrl.searchParams.set('scope', 'trade');
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('code_challenge', challenge);
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');

      return jsonResponse(
        { authorizationUrl: authorizationUrl.toString() },
        200,
        { 'Set-Cookie': 'deriv_oauth=' + cookieValue + '; HttpOnly; Secure; SameSite=Lax; Path=/api/deriv; Max-Age=600' }
      );
    } catch (error) {
      console.error('Deriv OAuth start failed:', { name: error?.name || 'Error' });
      return jsonResponse({ error: 'Could not start Deriv connection.' }, 500);
    }
  };
}

export function createDerivCallbackHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const cryptoImpl = dependencies.cryptoImpl || crypto;
  const now = dependencies.now || Date.now;

  return async function onRequestGet({ request, env }) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { ...noStoreHeaders, Allow: 'GET' }
      });
    }

    const finish = (status) => new Response(null, {
      status: 303,
      headers: {
        ...noStoreHeaders,
        Location: new URL('/?deriv=' + encodeURIComponent(status), request.url).toString(),
        'Set-Cookie': clearOAuthCookie()
      }
    });

    let stage = 'configuration';
    try {
      if (
        !env.DERIV_CLIENT_ID ||
        !env.DERIV_REDIRECT_URI ||
        !env.DERIV_OAUTH_SECRET ||
        !env.TOKEN_ENCRYPTION_KEY ||
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_ROLE_KEY
      ) return finish('error');

      stage = 'cookie';
      const cookieValue = readOAuthCookie(request);
      if (!cookieValue) return finish('error');

      stage = 'cookie_validation';
      const session = verifySignedOAuthCookie(cookieValue, env.DERIV_OAUTH_SECRET, cryptoImpl, now());
      if (!session) return finish('error');

      stage = 'callback_parameters';
      const params = new URL(request.url).searchParams;
      if (params.has('error')) return finish('cancelled');
      const code = params.get('code');
      const state = params.get('state');
      if (!code || !state || state !== session.state) return finish('error');

      stage = 'deriv_token_exchange';
      const tokenResponse = await fetchImpl('https://auth.deriv.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.DERIV_CLIENT_ID,
          code,
          code_verifier: session.verifier,
          redirect_uri: env.DERIV_REDIRECT_URI
        }),
        signal: AbortSignal.timeout(12000)
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (
        !tokenResponse.ok ||
        typeof tokenData.access_token !== 'string' ||
        !tokenData.access_token ||
        !Number.isFinite(Number(tokenData.expires_in)) ||
        Number(tokenData.expires_in) <= 0
      ) return finish('error');

      stage = 'deriv_account_verification';
      const accountsResponse = await fetchImpl('https://api.derivws.com/trading/v1/options/accounts', {
        headers: {
          Authorization: 'Bearer ' + tokenData.access_token,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      });
      const accountsPayload = await accountsResponse.json().catch(() => ({}));
      const rawAccounts = Array.isArray(accountsPayload.data)
        ? accountsPayload.data
        : Array.isArray(accountsPayload.data?.accounts) ? accountsPayload.data.accounts : [];
      if (!accountsResponse.ok || rawAccounts.length === 0) return finish('error');

      const eligible = rawAccounts.filter((account) => {
        const status = String(account?.status || 'active').toLowerCase();
        return Boolean(account?.account_id) && status === 'active';
      });
      const demoAccount = eligible.find((account) =>
        String(account.account_type || account.type || '').toLowerCase() === 'demo'
      );
      const realAccount = eligible.find((account) =>
        String(account.account_type || account.type || '').toLowerCase() === 'real'
      );
      if (!demoAccount) return finish('error');

      stage = 'token_encryption';
      const encryptedToken = encryptDerivToken(tokenData.access_token, env.TOKEN_ENCRYPTION_KEY, cryptoImpl);
      const tokenExpiresAt = new Date(now() + Number(tokenData.expires_in) * 1000).toISOString();

      stage = 'supabase_save';
      const supabase = adminClient(createClientImpl, env);
      const { error: saveError } = await supabase
        .from('deriv_connections')
        .upsert({
          user_id: session.userId,
          deriv_account_id: String(demoAccount.account_id),
          demo_account_id: String(demoAccount.account_id),
          real_account_id: realAccount ? String(realAccount.account_id) : null,
          token_expires_at: tokenExpiresAt,
          encrypted_access_token: encryptedToken,
          updated_at: new Date(now()).toISOString()
        }, { onConflict: 'user_id' });

      if (saveError) return finish('error');
      return finish('connected');
    } catch (error) {
      console.error('Deriv callback failed:', { stage, name: error?.name || 'Error' });
      return finish('error');
    }
  };
}

export function createDerivStatusHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const now = dependencies.now || Date.now;

  return async function onRequestGet({ request, env }) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Server configuration incomplete.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Sign in is required.' }, 401);

    try {
      const admin = adminClient(createClientImpl, env);
      const { data: auth, error: authError } = await admin.auth.getUser(token);
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Your login session is invalid.' }, 401);
      }

      const { data, error } = await admin
        .from('deriv_connections')
        .select('deriv_account_id,demo_account_id,real_account_id,token_expires_at,updated_at')
        .eq('user_id', auth.user.id)
        .maybeSingle();

      if (error) {
        console.error('Deriv status lookup failed:', { code: error.code || null });
        return jsonResponse({ error: 'Deriv connection status is temporarily unavailable.' }, 503);
      }

      const expiry = data?.token_expires_at ? Date.parse(data.token_expires_at) : 0;
      const tokenValid = Number.isFinite(expiry) && expiry > now();
      return jsonResponse({
        connected: Boolean(data?.demo_account_id && tokenValid),
        demoAccountId: data?.demo_account_id || null,
        realAccountId: data?.real_account_id || null,
        tokenValid,
        tokenExpiresAt: data?.token_expires_at || null,
        connectedAt: data?.updated_at || null
      });
    } catch (error) {
      console.error('Deriv status request failed:', { name: error?.name || 'Error' });
      return jsonResponse({ error: 'Could not check Deriv connection.' }, 500);
    }
  };
}

export function createDerivDisconnectHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Server configuration incomplete.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Sign in is required.' }, 401);

    try {
      const admin = adminClient(createClientImpl, env);
      const { data: auth, error: authError } = await admin.auth.getUser(token);
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Your login session is invalid.' }, 401);
      }

      const { error } = await admin
        .from('deriv_connections')
        .delete()
        .eq('user_id', auth.user.id);

      if (error) {
        console.error('Deriv disconnect failed:', { code: error.code || null });
        return jsonResponse({ error: 'Could not disconnect Deriv right now.' }, 503);
      }
      return jsonResponse({ disconnected: true });
    } catch (error) {
      console.error('Deriv disconnect request failed:', { name: error?.name || 'Error' });
      return jsonResponse({ error: 'Could not disconnect Deriv.' }, 500);
    }
  };
}
