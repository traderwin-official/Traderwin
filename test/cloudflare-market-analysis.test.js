import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketAnalysisHandler } from '../lib/cloudflare-market-analysis.js';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-placeholder'
};

const market = (instrument, timeframe) => ({
  instrument,
  providerSymbol: 'frx' + instrument,
  timeframe,
  source: 'DERIV',
  latestCandleAsOf: '2026-11-15T10:15:00.000Z',
  candles: [{ epoch: 1, open: 100, high: 102, low: 99, close: 101 }]
});

function adminClient(valid = true) {
  return {
    auth: {
      getUser: async () => valid
        ? { data: { user: { id: 'user-123' } }, error: null }
        : { data: { user: null }, error: { message: 'invalid session' } }
    }
  };
}

function post(body, token = 'valid-session') {
  return new Request('https://preview.example.pages.dev/api/analysis/market', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('market analysis fails closed when Supabase is not configured', async () => {
  const handler = createMarketAnalysisHandler();
  const response = await handler({ request: post({ instrument: 'XAUUSD' }), env: {} });
  assert.equal(response.status, 503);
});

test('market analysis requires a signed-in Supabase user', async () => {
  const handler = createMarketAnalysisHandler();
  const response = await handler({ request: post({ instrument: 'XAUUSD' }, null), env });
  assert.equal(response.status, 401);
});

test('market analysis rejects invalid Supabase sessions', async () => {
  const handler = createMarketAnalysisHandler({ createClientImpl: () => adminClient(false) });
  const response = await handler({ request: post({ instrument: 'XAUUSD' }), env });
  assert.equal(response.status, 401);
});

test('market analysis validates instrument, mode and strategy before requesting candles', async () => {
  let candleCalls = 0;
  const handler = createMarketAnalysisHandler({
    createClientImpl: () => adminClient(),
    getCandlesImpl: async () => { candleCalls += 1; return market('XAUUSD', 'M15'); }
  });

  const badInstrument = await handler({ request: post({ instrument: 'XAU/USD' }), env });
  assert.equal(badInstrument.status, 400);
  const badMode = await handler({ request: post({ instrument: 'XAUUSD', accountMode: 'LIVE' }), env });
  assert.equal(badMode.status, 400);
  const badStrategy = await handler({ request: post({ instrument: 'XAUUSD', strategy: 'UNSAFE' }), env });
  assert.equal(badStrategy.status, 400);
  assert.equal(candleCalls, 0);
});

test('market analysis returns a no-execution result for an authenticated request', async () => {
  let strategyInput;
  const handler = createMarketAnalysisHandler({
    createClientImpl: () => adminClient(),
    getCandlesImpl: async (instrument, timeframe) => market(instrument, timeframe),
    analyseStrategyImpl: (candles, strategy, options) => {
      strategyInput = { candles, strategy, options };
      return { signal: 'WAIT', confirmations: [] };
    },
    now: () => Date.parse('2026-11-15T10:20:00.000Z')
  });

  const response = await handler({
    request: post({
      instrument: 'xauusd',
      timeframe: 'M15',
      accountMode: 'REAL',
      strategy: 'MULTI_CONFIRMATION_V1'
    }),
    env
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.instrument, 'XAUUSD');
  assert.equal(body.source, 'DERIV');
  assert.equal(body.accountMode, 'REAL');
  assert.equal(body.execution, 'NONE');
  assert.equal(body.result.signal, 'WAIT');
  assert.equal(body.analysedAt, '2026-11-15T10:20:00.000Z');
  assert.equal(strategyInput.strategy, 'MULTI_CONFIRMATION_V1');
  assert.equal(strategyInput.options.instrument, 'XAUUSD');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Tiger Fibonacci psychology requests H1 trend candles when analysing a lower timeframe', async () => {
  const calls = [];
  let trendCandles;
  const handler = createMarketAnalysisHandler({
    createClientImpl: () => adminClient(),
    getCandlesImpl: async (instrument, timeframe) => {
      calls.push(timeframe);
      return market(instrument, timeframe);
    },
    analyseStrategyImpl: (_candles, _strategy, options) => {
      trendCandles = options.trendCandles;
      return { signal: 'WAIT' };
    }
  });

  const response = await handler({
    request: post({
      instrument: 'EURUSD',
      timeframe: 'M15',
      strategy: 'TIGER_FIBONACCI_PSYCHOLOGY_V1'
    }),
    env
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['M15', 'H1']);
  assert.equal(trendCandles.length, 1);
  assert.equal((await response.json()).trendTimeframe, 'H1');
});

test('market analysis fails closed when Deriv data is stale or unavailable', async () => {
  const handler = createMarketAnalysisHandler({
    createClientImpl: () => adminClient(),
    getCandlesImpl: async () => { throw new Error('Latest completed candle is stale; no fresh strategy analysis was produced.'); }
  });
  const response = await handler({ request: post({ instrument: 'XAUUSD' }), env });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /stale/i);
});

test('market analysis rejects methods other than POST', async () => {
  const handler = createMarketAnalysisHandler();
  const response = await handler({
    request: new Request('https://preview.example.pages.dev/api/analysis/market', { method: 'GET' }),
    env
  });
  assert.equal(response.status, 405);
});
