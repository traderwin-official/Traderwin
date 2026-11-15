import { createClient } from '@supabase/supabase-js';
import { getDerivCandles } from './deriv-candles.js';
import { analyseStrategy } from './strategy-engine.js';

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

export function createMarketAnalysisHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const getCandlesImpl = dependencies.getCandlesImpl || getDerivCandles;
  const analyseStrategyImpl = dependencies.analyseStrategyImpl || analyseStrategy;
  const now = dependencies.now || Date.now;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405);
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: 'Market analyst is not configured.' }, 503);
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

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Send a valid JSON analysis request.' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

      const instrument = String(body.instrument || '').trim().toUpperCase();
      const timeframe = String(body.timeframe || 'M15').trim().toUpperCase();
      if (!/^[A-Z0-9_]{2,24}$/.test(instrument)) {
        return jsonResponse({ error: 'Choose a supported instrument.' }, 400);
      }

      const accountMode = String(body.accountMode || 'DEMO').trim().toUpperCase();
      if (!['DEMO', 'REAL'].includes(accountMode)) {
        return jsonResponse({ error: 'Choose DEMO or REAL analysis mode.' }, 400);
      }

      const strategy = String(body.strategy || 'MULTI_CONFIRMATION_V1');
      if (!['MULTI_CONFIRMATION_V1', 'TIGER_FIBONACCI_PSYCHOLOGY_V1', 'MANUAL_REVIEW'].includes(strategy)) {
        return jsonResponse({ error: 'Choose a supported strategy.' }, 400);
      }

      const market = await getCandlesImpl(instrument, timeframe);
      const usesHigherTimeframeTrend = strategy === 'TIGER_FIBONACCI_PSYCHOLOGY_V1' && timeframe !== 'H1';
      const trendMarket = usesHigherTimeframeTrend
        ? await getCandlesImpl(instrument, 'H1')
        : market;
      const result = analyseStrategyImpl(market.candles, strategy, {
        trendCandles: trendMarket.candles,
        instrument
      });

      return jsonResponse({
        ok: true,
        instrument: market.instrument,
        providerSymbol: market.providerSymbol,
        timeframe: market.timeframe,
        source: market.source,
        strategy,
        accountMode,
        trendTimeframe: strategy === 'TIGER_FIBONACCI_PSYCHOLOGY_V1' ? 'H1' : timeframe,
        latestCandleAsOf: market.latestCandleAsOf,
        analysedAt: new Date(now()).toISOString(),
        result,
        execution: 'NONE',
        message: 'Smart strategy analysis only. No order was opened, modified or closed.'
      });
    } catch (error) {
      console.error('Market analysis failed:', { name: error?.name || 'Error' });
      return jsonResponse({
        error: error?.message || 'Could not analyse the selected market.'
      }, 503);
    }
  };
}
