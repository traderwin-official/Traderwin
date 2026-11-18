import { createClient } from '@supabase/supabase-js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    ...headers
  }
});

const LICENSE_PATTERN = /^TW-(?:[A-Z0-9]{4}-){5}[A-Z0-9]{4}$/;
const LOGIN_PATTERN = /^\d{4,20}$/;

function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || '').trim().slice(0, 100);
}

async function sha256Hex(value, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function consumeLimit({ env, key, limit }) {
  const limiter = env.APP_RATE_LIMITER;
  const token = env.APP_RATE_LIMITER_TOKEN;
  if (!limiter || typeof limiter.fetch !== 'function' || !token) {
    return { ok: false, response: json({ valid: false, error: 'License verification is temporarily unavailable while rate protection is configured.' }, 503) };
  }
  try {
    const response = await limiter.fetch('https://rate-limit.internal/check', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ key, limit, windowSeconds: 60 })
    });
    if (!response.ok) {
      return { ok: false, response: json({ valid: false, error: 'License rate protection is unavailable. Please try again later.' }, 503) };
    }
    const result = await response.json().catch(() => null);
    if (!result || typeof result.allowed !== 'boolean') {
      return { ok: false, response: json({ valid: false, error: 'License rate protection returned an invalid response.' }, 503) };
    }
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.min(120, Number(result.retryAfterSeconds) || 60));
      return {
        ok: false,
        response: json(
          { valid: false, error: 'Too many license requests. Please wait before trying again.' },
          429,
          { 'Retry-After': String(retryAfter) }
        )
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, response: json({ valid: false, error: 'License rate protection is unavailable. Please try again later.' }, 503) };
  }
}

export function createBotLicenseHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const cryptoImpl = dependencies.cryptoImpl || globalThis.crypto;
  const now = dependencies.now || Date.now;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') {
      return json({ valid: false, error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ||
        !env.APP_RATE_LIMITER || typeof env.APP_RATE_LIMITER.fetch !== 'function' ||
        !env.APP_RATE_LIMITER_TOKEN) {
      return json({ valid: false, error: 'License verification is not configured.' }, 503);
    }

    const ip = clientIp(request);
    if (!ip) return json({ valid: false, error: 'Request origin could not be verified.' }, 503);

    // Apply an IP limit before parsing the license key to slow key enumeration.
    const ipLimit = await consumeLimit({ env, key: 'bot-license-ip:' + ip, limit: 30 });
    if (!ipLimit.ok) return ipLimit.response;

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 4096) return json({ valid: false, error: 'Request is too large.' }, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ valid: false, error: 'Provide a valid JSON request body.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ valid: false, error: 'Provide a valid request body.' }, 400);
    }

    const key = String(body.licenseKey || '').trim().toUpperCase();
    const mt5Login = String(body.mt5Login || '').trim();
    const mt5Server = String(body.mt5Server || '').trim().slice(0, 100);
    const action = String(body.action || 'ACTIVATE').trim().toUpperCase();
    if (!LICENSE_PATTERN.test(key) || !LOGIN_PATTERN.test(mt5Login) ||
        mt5Server.length < 2 || !['ACTIVATE', 'VERIFY'].includes(action)) {
      return json({ valid: false, error: 'Provide a valid license key, MT5 account number, broker server and action.' }, 400);
    }

    let keyHash;
    try {
      keyHash = await sha256Hex(key, cryptoImpl);
    } catch {
      return json({ valid: false, error: 'License verification is temporarily unavailable.' }, 503);
    }
    const keyLimit = await consumeLimit({ env, key: 'bot-license-key:' + keyHash, limit: 6 });
    if (!keyLimit.ok) return keyLimit.response;

    try {
      const db = createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { data: license, error: licenseError } = await db.from('bot_licenses')
        .select('id,product_code,license_type,status,expires_at,bound_mt5_login,bound_mt5_server,activated_at')
        .eq('license_key_hash', keyHash)
        .maybeSingle();
      if (licenseError) return json({ valid: false, error: 'License verification is temporarily unavailable.' }, 503);
      if (!license || license.status !== 'ACTIVE') {
        return json({ valid: false, error: 'License not found or not active. Contact Tiger Scheme support.' }, 403);
      }

      if (license.expires_at) {
        const expiry = Date.parse(license.expires_at);
        if (!Number.isFinite(expiry)) {
          return json({ valid: false, error: 'The license expiry record is invalid. Contact Tiger Scheme support.' }, 503);
        }
        if (expiry <= now()) {
          const { error: expiryError } = await db.from('bot_licenses')
            .update({ status: 'EXPIRED' })
            .eq('id', license.id)
            .eq('status', 'ACTIVE');
          if (expiryError) return json({ valid: false, error: 'Could not update the expired license status.' }, 503);
          return json({ valid: false, error: 'This license has expired.' }, 403);
        }
      }

      if (license.bound_mt5_login) {
        if (license.bound_mt5_login !== mt5Login || license.bound_mt5_server !== mt5Server) {
          return json({ valid: false, error: 'This license is already bound to a different MT5 account. Request a license transfer from Tiger Scheme.' }, 403);
        }
        const { data: verified, error: verifyError } = await db.from('bot_licenses')
          .update({ last_verified_at: new Date(now()).toISOString() })
          .eq('id', license.id)
          .eq('status', 'ACTIVE')
          .eq('bound_mt5_login', mt5Login)
          .eq('bound_mt5_server', mt5Server)
          .select('id')
          .maybeSingle();
        if (verifyError) return json({ valid: false, error: 'Could not update license verification time.' }, 503);
        if (!verified) return json({ valid: false, error: 'License binding changed during this request. Verify again.' }, 409);
      } else {
        if (action === 'VERIFY') {
          return json({ valid: false, error: 'This license has not been activated on an MT5 account yet.' }, 409);
        }
        const timestamp = new Date(now()).toISOString();
        const { data: activated, error: activationError } = await db.from('bot_licenses')
          .update({
            bound_mt5_login: mt5Login,
            bound_mt5_server: mt5Server,
            activated_at: timestamp,
            last_verified_at: timestamp
          })
          .eq('id', license.id)
          .eq('status', 'ACTIVE')
          .is('bound_mt5_login', null)
          .select('id')
          .maybeSingle();
        if (activationError) return json({ valid: false, error: 'Could not activate this license safely.' }, 503);

        if (!activated) {
          // A concurrent request may have won the compare-and-set. Treat the
          // same account as an idempotent retry; never permit a different bind.
          const { data: latest, error: reloadError } = await db.from('bot_licenses')
            .select('id,status,bound_mt5_login,bound_mt5_server')
            .eq('id', license.id)
            .maybeSingle();
          if (reloadError) return json({ valid: false, error: 'Could not confirm the license binding.' }, 503);
          if (!latest || latest.status !== 'ACTIVE') {
            return json({ valid: false, error: 'License not found or not active.' }, 403);
          }
          if (latest.bound_mt5_login !== mt5Login || latest.bound_mt5_server !== mt5Server) {
            return json({ valid: false, error: 'License activation changed during this request. Please verify again.' }, 409);
          }
        }
      }

      return json({
        valid: true,
        productCode: license.product_code,
        licenseType: license.license_type,
        expiresAt: license.expires_at || null,
        accountBound: true,
        message: 'Tiger Scheme license verified. This check does not connect to MT5 or place trades.'
      });
    } catch (error) {
      console.error('Tiger Scheme license verification failed:', error?.code || error?.name || 'unknown');
      return json({ valid: false, error: 'License verification is temporarily unavailable.' }, 503);
    }
  };
}
