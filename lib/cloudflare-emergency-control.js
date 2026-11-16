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

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function validAccountRef(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200;
}

async function readInput(request, method) {
  if (method === 'GET') {
    return Object.fromEntries(new URL(request.url).searchParams.entries());
  }
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function createEmergencyControlHandler(method, dependencies = {}) {
  if (!['GET', 'POST'].includes(method)) throw new TypeError('Unsupported emergency-control method.');

  const createClientImpl = dependencies.createClientImpl || createClient;

  return async function onRequest({ request, env }) {
    if (request.method !== method) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: method });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Emergency controls are not configured.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Sign in is required.' }, 401);

    const body = await readInput(request, method);
    if (!body) return jsonResponse({ error: 'Provide a valid request body.' }, 400);

    const accountMode = String(body.accountMode || '').trim().toUpperCase();
    const broker = String(body.broker || '').trim().toUpperCase();
    const accountRef = typeof body.accountRef === 'string' ? body.accountRef.trim() : '';
    const action = String(body.action || 'STATUS').trim().toUpperCase();

    if (
      !['DEMO', 'REAL'].includes(accountMode) ||
      !['DERIV', 'MT5'].includes(broker) ||
      !validAccountRef(accountRef) ||
      !['STATUS', 'STOP_ENTRIES', 'CLEAR_STOP'].includes(action)
    ) {
      return jsonResponse({ error: 'Provide a valid account mode, broker, account reference and action.' }, 400);
    }

    try {
      const db = createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { data: auth, error: authError } = await db.auth.getUser(token);
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Your login session is invalid.' }, 401);
      }
      const userId = auth.user.id;

      if (accountMode === 'DEMO' && accountRef !== `DEMO:${userId}`) {
        return jsonResponse({ error: 'DEMO controls must use your own server-defined demo account reference.' }, 403);
      }

      if (accountMode === 'REAL') {
        const { data: connection, error: connectionError } = await db
          .from('broker_connections')
          .select('external_account_id,connection_status,verified_at,account_mode')
          .eq('user_id', userId)
          .eq('provider', broker)
          .eq('external_account_id', accountRef)
          .eq('account_mode', 'REAL')
          .maybeSingle();

        if (connectionError) {
          return jsonResponse({ error: 'Could not verify the broker account.' }, 503);
        }
        if (
          !connection ||
          connection.connection_status !== 'CONNECTED' ||
          !connection.verified_at ||
          connection.account_mode !== 'REAL'
        ) {
          return jsonResponse({ error: 'REAL emergency controls require a verified broker account connection.' }, 403);
        }
      }

      const key = {
        user_id: userId,
        account_mode: accountMode,
        broker,
        broker_account_ref: accountRef
      };

      // GET is always read-only, even if a caller supplies an action query parameter.
      if (method === 'GET' || action === 'STATUS') {
        const { data, error } = await db.from('bot_emergency_controls')
          .select('kill_switch_active,reason,changed_at')
          .match(key)
          .maybeSingle();

        if (error) {
          return jsonResponse({ error: 'Could not load emergency status. The emergency-controls database migration may be missing.' }, 503);
        }
        return jsonResponse({
          ok: true,
          accountMode,
          broker,
          killSwitchActive: data?.kill_switch_active ?? false,
          changedAt: data?.changed_at ?? null,
          reason: data?.reason ?? null,
          note: 'This control blocks new entries only. It does not close open positions.'
        });
      }

      const active = action === 'STOP_ENTRIES';
      const { data, error } = await db.from('bot_emergency_controls').upsert({
        ...key,
        kill_switch_active: active,
        reason: active ? 'USER_EMERGENCY_STOP' : null,
        changed_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,account_mode,broker,broker_account_ref'
      }).select('kill_switch_active,reason,changed_at').single();

      if (error || !data) {
        return jsonResponse({ error: 'Could not save emergency control.' }, 503);
      }

      // Preserve the existing audit event. The latch itself is the authoritative state.
      const { error: activityError } = await db.from('bot_activity').insert({
        user_id: userId,
        event_type: active ? 'STOP_REQUESTED' : 'CONFIG_SAVED',
        account_mode: accountMode,
        details: {
          control: 'EMERGENCY_ENTRY_KILL_SWITCH',
          broker,
          account_ref: accountRef,
          active
        }
      });
      if (activityError) {
        console.error('Emergency control audit insert failed:', activityError.code || 'UNKNOWN');
      }

      return jsonResponse({
        ok: true,
        killSwitchActive: data.kill_switch_active,
        changedAt: data.changed_at,
        note: active
          ? 'New entries are halted. Existing positions remain open and require separately authorized risk management.'
          : 'The emergency latch is cleared. Bot entries must still pass all connection, quote, risk and execution checks.'
      });
    } catch (error) {
      console.error('Emergency control request failed:', error?.name || 'Error');
      return jsonResponse({ error: 'Emergency control request failed.' }, 500);
    }
  };
}
