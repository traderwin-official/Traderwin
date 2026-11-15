import { createClient } from '@supabase/supabase-js';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

export function createSubscriptionStatusHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const now = dependencies.now || Date.now;

  return async function onRequestGet({ request, env }) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed.' }, 405);
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Subscription service is not configured.' }, 503);
    }

    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ') || !authorization.slice(7).trim()) {
      return jsonResponse({ error: 'Sign in is required.' }, 401);
    }

    try {
      const admin = createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { data: auth, error: authError } = await admin.auth.getUser(authorization.slice(7).trim());
      if (authError || !auth?.user?.id) {
        return jsonResponse({ error: 'Your login session is invalid.' }, 401);
      }

      const { data, error } = await admin.from('user_subscriptions')
        .select('service_code,status,starts_at,ends_at,payment_order_id')
        .eq('user_id', auth.user.id)
        .eq('service_code', 'REAL_TRADING')
        .maybeSingle();

      if (error) {
        console.error('Subscription status lookup failed:', { code: error.code || null });
        return jsonResponse({ error: 'Could not load subscription status.' }, 503);
      }

      const end = data?.ends_at ? Date.parse(data.ends_at) : null;
      const active = data?.status === 'ACTIVE' && Number.isFinite(end) && end > now();
      return jsonResponse({
        serviceCode: 'REAL_TRADING',
        status: active ? 'ACTIVE' : data?.status === 'ACTIVE' ? 'EXPIRED' : (data?.status || 'NOT_PURCHASED'),
        active,
        startsAt: data?.starts_at || null,
        endsAt: data?.ends_at || null,
        renewalMode: 'MANUAL',
        realExecutionAuthorized: false,
        message: active
          ? 'Subscription is active. Broker verification and separate REAL-trading authorization are still required.'
          : 'No active REAL trading subscription. DEMO access remains free.'
      });
    } catch (error) {
      console.error('Subscription status request failed:', { name: error?.name || 'Error' });
      return jsonResponse({ error: 'Could not check subscription status.' }, 500);
    }
  };
}
