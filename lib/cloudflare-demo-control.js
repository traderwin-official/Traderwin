import { createClient } from '@supabase/supabase-js';

const noStoreHeaders = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };
const json = (payload, status = 200, extraHeaders = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { ...noStoreHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
});
const safeError = error => String(error?.message || 'Database operation failed').slice(0, 180);

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  if (!value.startsWith('Bearer ')) return null;
  return value.slice(7).trim() || null;
}

function nairobiDayStart(now) {
  const local = new Date(now + 3 * 60 * 60 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - 3 * 60 * 60 * 1000).toISOString();
}

export function createDemoControlHandler(dependencies = {}) {
  const createClientImpl = dependencies.createClientImpl || createClient;
  const now = dependencies.now || Date.now;

  return async function onRequestPost({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Demo bot service is not configured.' }, 503);
    }

    const token = bearerToken(request);
    if (!token) return json({ error: 'Sign in is required.' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Provide a valid JSON request body.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Provide a valid request body.' }, 400);
    }
    const action = String(body.action || '').trim().toUpperCase();
    if (!['START', 'STOP', 'STATUS'].includes(action)) {
      return json({ error: 'Choose START, STOP or STATUS.' }, 400);
    }

    try {
      const db = createClientImpl(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { data: auth, error: authError } = await db.auth.getUser(token);
      if (authError || !auth?.user?.id) return json({ error: 'Your login session is invalid.' }, 401);
      const userId = auth.user.id;

      if (action === 'STATUS') {
        const { data: active, error: activeError } = await db.from('demo_bot_sessions')
          .select('id,status,current_balance,virtual_currency,started_at,bot_setting_id')
          .eq('user_id', userId)
          .eq('account_mode', 'DEMO')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (activeError) return json({ error: 'Could not load demo session status.' }, 503);
        if (!active) {
          return json({
            ok: true, session: null, openTrade: null, workerHeartbeat: null,
            message: 'No demo session exists yet.'
          });
        }

        const { data: workerHeartbeat, error: heartbeatError } = await db.from('demo_bot_worker_heartbeats')
          .select('last_tick_at,last_action,last_reason,last_error')
          .eq('session_id', active.id)
          .eq('user_id', userId)
          .maybeSingle();
        if (heartbeatError) return json({ error: 'Could not load DEMO worker health status.' }, 503);

        const { data: settings, error: settingsError } = await db.from('bot_settings')
          .select('instrument')
          .eq('id', active.bot_setting_id)
          .eq('user_id', userId)
          .maybeSingle();
        if (settingsError) return json({ error: 'Could not load saved bot settings.' }, 503);

        const { data: openTrade, error: tradeError } = await db.from('demo_bot_trades')
          .select('id,symbol,direction,entry_price,stop_loss,take_profit,status')
          .eq('user_id', userId)
          .eq('status', 'OPEN')
          .order('opened_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (tradeError) return json({ error: 'Could not load your open paper trade.' }, 503);

        return json({
          ok: true,
          session: { ...active, instrument: settings?.instrument || null },
          openTrade: openTrade || null,
          workerHeartbeat: workerHeartbeat || null,
          message: 'Demo session and worker status loaded.'
        });
      }

      if (action === 'START') {
        const { data: profile, error: profileError } = await db.from('trader_profiles')
          .select('account_mode,max_risk_per_trade_pct,max_daily_loss_pct')
          .eq('user_id', userId)
          .maybeSingle();
        if (profileError) return json({ error: 'Could not verify your account risk settings.' }, 503);
        if (!profile) return json({ error: 'Complete your account setup first.' }, 409);
        if (profile.account_mode !== 'DEMO') {
          return json({ error: 'Paper simulator only runs in DEMO mode. REAL mode is blocked.' }, 403);
        }

        const { data: settings, error: settingsError } = await db.from('bot_settings')
          .select('id,broker,instrument,account_mode,timeframe,strategy,max_risk_per_trade_pct')
          .eq('user_id', userId)
          .maybeSingle();
        if (settingsError) return json({ error: 'Could not load your saved bot preferences.' }, 503);
        if (!settings) return json({ error: 'Save your bot preferences first.' }, 409);
        if (settings.account_mode !== 'DEMO') return json({ error: 'Your saved bot settings are not DEMO.' }, 403);

        const broker = String(settings.broker || '').trim().toUpperCase();
        if (!['DERIV', 'MT5'].includes(broker)) return json({ error: 'Unsupported broker for emergency control.' }, 403);
        if (broker !== 'DERIV') {
          return json({ error: 'The unattended DEMO auto worker currently supports Deriv only. MT5 setup can be saved, but cannot be started yet.' }, 403);
        }
        if (!['MULTI_CONFIRMATION_V1', 'TIGER_FIBONACCI_PSYCHOLOGY_V1'].includes(settings.strategy)) {
          return json({ error: 'Choose a validated automated strategy. Manual review cannot start auto trading.' }, 409);
        }
        if (!['M5', 'M15', 'H1', 'H4'].includes(String(settings.timeframe || 'M15').toUpperCase())) {
          return json({ error: 'Choose M5, M15, H1 or H4 for the Smart Auto DEMO worker.' }, 409);
        }

        const { data: emergency, error: emergencyError } = await db.from('bot_emergency_controls')
          .select('kill_switch_active')
          .eq('user_id', userId)
          .eq('account_mode', 'DEMO')
          .eq('broker', 'DERIV')
          .eq('broker_account_ref', `DEMO:${userId}`)
          .maybeSingle();
        if (emergencyError) {
          return json({ error: 'Emergency control status is unavailable. Apply the emergency-controls migration before starting the bot.' }, 503);
        }
        if (emergency?.kill_switch_active) {
          return json({ error: 'Emergency stop is active. Clear it only after checking your account and risk controls.' }, 403);
        }

        const { data: modeProfile, error: modeProfileError } = await db.from('bot_mode_profiles')
          .select('max_risk_per_trade_pct,max_daily_loss_pct')
          .eq('user_id', userId)
          .eq('account_mode', 'DEMO')
          .maybeSingle();
        if (modeProfileError) return json({ error: 'Could not verify DEMO risk preferences.' }, 503);

        const { data: lastSession, error: lastError } = await db.from('demo_bot_sessions')
          .select('id,status,created_at')
          .eq('user_id', userId)
          .eq('account_mode', 'DEMO')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastError) return json({ error: 'Could not verify your previous demo session.' }, 503);
        if (
          lastSession?.status === 'RISK_LOCKED' &&
          new Date(lastSession.created_at).getTime() >= Date.parse(nairobiDayStart(now()))
        ) {
          return json({
            error: 'Your demo session hit its daily loss limit. The safety lock remains active until the next Nairobi trading day.'
          }, 403);
        }

        const { data: active, error: activeError } = await db.from('demo_bot_sessions')
          .select('id,status,current_balance,virtual_currency,started_at')
          .eq('user_id', userId)
          .eq('account_mode', 'DEMO')
          .in('status', ['RUNNING', 'PAUSED'])
          .maybeSingle();
        if (activeError) return json({ error: 'Could not check existing demo session.' }, 503);

        if (active?.status === 'PAUSED') {
          const { data: resumed, error: resumeError } = await db.from('demo_bot_sessions')
            .update({ status: 'RUNNING', stopped_at: null, updated_at: new Date(now()).toISOString() })
            .eq('id', active.id)
            .eq('user_id', userId)
            .eq('status', 'PAUSED')
            .select('id,status,current_balance,virtual_currency,started_at')
            .single();
          if (resumeError || !resumed) return json({ error: 'Could not resume DEMO session.' }, 503);
          return json({
            ok: true, session: resumed,
            message: 'DEMO automation resumed. The worker will continue managing any existing bot position.'
          });
        }
        if (active) {
          return json({ ok: true, session: active, message: 'Demo paper session is already running.' });
        }

        const { data: orphanOpen, error: orphanError } = await db.from('demo_bot_trades')
          .select('id,trade_source')
          .eq('user_id', userId)
          .eq('status', 'OPEN')
          .limit(1);
        if (orphanError) return json({ error: 'Could not verify existing open DEMO positions.' }, 503);
        if (orphanOpen?.length) {
          return json({
            error: 'Close your existing open DEMO position before starting a new session. This protects the account from unmanaged overlapping positions.'
          }, 409);
        }

        const maxRisk = Math.min(
          Number(profile.max_risk_per_trade_pct),
          Number(settings.max_risk_per_trade_pct),
          Number(modeProfile?.max_risk_per_trade_pct || profile.max_risk_per_trade_pct)
        );
        const maxDailyLoss = Math.min(
          Number(profile.max_daily_loss_pct),
          Number(modeProfile?.max_daily_loss_pct || profile.max_daily_loss_pct)
        );
        if (![maxRisk, maxDailyLoss].every(Number.isFinite) || maxRisk <= 0 || maxDailyLoss <= 0) {
          return json({ error: 'Valid DEMO risk limits are required before starting.' }, 409);
        }

        const { data: session, error: sessionError } = await db.from('demo_bot_sessions').insert({
          user_id: userId,
          bot_setting_id: settings.id,
          account_mode: 'DEMO',
          status: 'RUNNING',
          starting_balance: 10000,
          current_balance: 10000,
          max_risk_per_trade_pct: maxRisk,
          max_daily_loss_pct: maxDailyLoss
        }).select('id,status,current_balance,virtual_currency,started_at').single();
        if (sessionError || !session) {
          console.error('DEMO session start failed:', sessionError?.code || 'UNKNOWN');
          return json({ error: 'Could not start demo session. Check for an existing session.' }, 409);
        }

        const { error: activityError } = await db.from('bot_activity').insert({
          user_id: userId,
          bot_setting_id: settings.id,
          event_type: 'START_REQUESTED',
          account_mode: 'DEMO',
          details: { session_id: session.id, instrument: settings.instrument, simulator: 'PAPER_ONLY' }
        });
        if (activityError) console.error('DEMO start audit insert failed:', activityError.code || 'UNKNOWN');

        return json({
          ok: true,
          session: { ...session, instrument: settings.instrument },
          message: 'Smart Auto DEMO session started. The scheduled worker will analyse Deriv data and manage virtual positions; no broker orders are sent.'
        });
      }

      const { data: session, error: sessionError } = await db.from('demo_bot_sessions')
        .select('id,bot_setting_id')
        .eq('user_id', userId)
        .eq('account_mode', 'DEMO')
        .eq('status', 'RUNNING')
        .maybeSingle();
      if (sessionError) return json({ error: 'Could not load active demo session.' }, 503);
      if (!session) return json({ ok: true, session: null, message: 'No demo session is running.' });

      const { data: openPosition, error: positionError } = await db.from('demo_bot_trades')
        .select('id,trade_source')
        .eq('session_id', session.id)
        .eq('user_id', userId)
        .eq('status', 'OPEN')
        .maybeSingle();
      if (positionError) return json({ error: 'Could not verify the open DEMO position before stopping.' }, 503);

      const nextStatus = openPosition?.trade_source === 'BOT' ? 'PAUSED' : 'STOPPED';
      const { data: stopped, error: stopError } = await db.from('demo_bot_sessions')
        .update({ status: nextStatus, stopped_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() })
        .eq('id', session.id)
        .eq('user_id', userId)
        .eq('status', 'RUNNING')
        .select('id,status')
        .maybeSingle();
      if (stopError || !stopped) return json({ error: 'Could not stop demo session.' }, 503);

      const { error: activityError } = await db.from('bot_activity').insert({
        user_id: userId,
        bot_setting_id: session.bot_setting_id,
        event_type: 'STOP_REQUESTED',
        account_mode: 'DEMO',
        details: { session_id: session.id, status: nextStatus, open_bot_position_retained: nextStatus === 'PAUSED' }
      });
      if (activityError) console.error('DEMO stop audit insert failed:', activityError.code || 'UNKNOWN');

      return json({
        ok: true,
        session: { id: session.id, status: nextStatus },
        message: nextStatus === 'PAUSED'
          ? 'New entries are stopped. The worker will continue managing your existing BOT position until it closes; then the session stays paused.'
          : 'DEMO session stopped. Any manual paper position remains under your control.'
      });
    } catch (error) {
      console.error('DEMO control request failed:', error?.name || 'Error');
      return json({ error: 'Demo bot service encountered an error.' }, 500);
    }
  };
}
