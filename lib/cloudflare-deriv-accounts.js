import { createClient } from '@supabase/supabase-js';
import { normalizeVerifiedDerivAccounts } from './deriv-accounts.js';

const noStoreHeaders = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...noStoreHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

function adminClient(createClientImpl, env) {
  return createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function validConnectionExpiry(value, now) {
  const expiry = value ? Date.parse(value) : 0;
  return Number.isFinite(expiry) && expiry > now;
}

export function createDerivAccountsHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const now = dependencies.now || Date.now;

  return async function onRequestGet({ request, env }) {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed.' }, 405);
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Server configuration incomplete.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Login required.' }, 401);

    try {
      const admin = adminClient(createClientImpl, env);
      const { data: auth, error: authError } = await admin.auth.getUser(token);
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Login session is invalid or expired.' }, 401);
      }

      const { data, error } = await admin
        .from('deriv_connections')
        .select('deriv_account_id,accounts,token_expires_at,connected_at')
        .eq('user_id', auth.user.id)
        .maybeSingle();

      if (error) {
        console.error('Deriv account list lookup failed:', { code: error.code || null });
        return jsonResponse({ error: 'Could not load connected Deriv accounts.' }, 503);
      }
      if (!data) return jsonResponse({ error: 'No Deriv connection found.' }, 404);
      if (!validConnectionExpiry(data.token_expires_at, now())) {
        return jsonResponse({ error: 'Deriv authorization expired. Reconnect to refresh your verified account list.' }, 409);
      }

      const accounts = normalizeVerifiedDerivAccounts({ accounts: data.accounts });
      return jsonResponse({
        accounts,
        selected_account_id: data.deriv_account_id || null,
        token_expires_at: data.token_expires_at,
        connected_at: data.connected_at || null,
        real_trading_enabled: false
      });
    } catch (error) {
      console.error('Deriv accounts endpoint error:', { name: error?.name || null });
      return jsonResponse({ error: 'Could not load Deriv accounts.' }, 500);
    }
  };
}

export function createDerivSelectAccountHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const now = dependencies.now || Date.now;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Server configuration incomplete.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Login required.' }, 401);

    const body = await request.json().catch(() => null);
    const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
    if (!accountId || accountId.length > 128) {
      return jsonResponse({ error: 'Choose a valid DEMO account.' }, 400);
    }

    try {
      const admin = adminClient(createClientImpl, env);
      const { data: auth, error: authError } = await admin.auth.getUser(token);
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Login session is invalid or expired.' }, 401);
      }

      const { data: connection, error: lookupError } = await admin
        .from('deriv_connections')
        .select('accounts,token_expires_at')
        .eq('user_id', auth.user.id)
        .maybeSingle();

      if (lookupError) {
        console.error('Deriv selection validation failed:', { code: lookupError.code || null });
        return jsonResponse({ error: 'Could not validate account selection.' }, 503);
      }
      if (!connection) return jsonResponse({ error: 'No Deriv connection found.' }, 404);
      if (!validConnectionExpiry(connection.token_expires_at, now())) {
        return jsonResponse({ error: 'Deriv authorization expired. Reconnect before selecting an account.' }, 409);
      }

      const verifiedAccounts = normalizeVerifiedDerivAccounts({ accounts: connection.accounts });
      const allowed = verifiedAccounts.some((account) =>
        account.account_id === accountId &&
        account.account_type === 'demo' &&
        account.status === 'active'
      );
      if (!allowed) {
        return jsonResponse({
          error: 'Only a verified active DEMO account can be selected. REAL accounts remain locked.'
        }, 403);
      }

      const { data: updated, error: updateError } = await admin
        .from('deriv_connections')
        .update({
          deriv_account_id: accountId,
          demo_account_id: accountId,
          updated_at: new Date(now()).toISOString()
        })
        .eq('user_id', auth.user.id)
        .eq('token_expires_at', connection.token_expires_at)
        .select('user_id')
        .maybeSingle();

      if (updateError) {
        console.error('Deriv account selection save failed:', { code: updateError.code || null });
        return jsonResponse({ error: 'Could not save selected DEMO account.' }, 503);
      }
      if (!updated) {
        return jsonResponse({ error: 'Deriv connection changed. Reload the account list and try again.' }, 409);
      }

      return jsonResponse({
        selected_account_id: accountId,
        message: 'DEMO account selected. Automation remains off and REAL trading remains locked.'
      });
    } catch (error) {
      console.error('Deriv account selection endpoint error:', { name: error?.name || null });
      return jsonResponse({ error: 'Could not save account selection.' }, 500);
    }
  };
}
