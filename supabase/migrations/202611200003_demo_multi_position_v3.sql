-- Multi-position DEMO ledger v3.
-- Only the isolated v2 paper tables are changed. Existing production demo_bot_*,
-- bot_settings, broker connections and account records are untouched.

alter table public.demo_paper_sessions
  add column if not exists max_open_positions integer not null default 3
    check (max_open_positions between 1 and 10),
  add column if not exists max_total_open_risk_pct numeric(5,2) not null default 2.00
    check (max_total_open_risk_pct > 0 and max_total_open_risk_pct <= 5);

-- Allow several simultaneous positions in the same virtual DEMO account.
-- Keep at most one BOT-managed position in a session for the current one-symbol
-- strategy runner; MANUAL positions can coexist with that BOT position.
drop index if exists public.demo_paper_one_open_trade_per_session;
drop index if exists public.demo_paper_one_open_trade_per_user;

create unique index if not exists demo_paper_one_open_bot_trade_per_session
  on public.demo_paper_trades(session_id)
  where status='OPEN' and trade_origin='BOT';

create index if not exists demo_paper_open_positions_by_user
  on public.demo_paper_trades(user_id,session_id,opened_at desc)
  where status='OPEN';

create or replace function public.open_demo_paper_trade(
 p_user_id uuid,p_session_id uuid,p_instrument text,p_side text,p_entry numeric,p_stop numeric,p_target numeric,
 p_quantity numeric,p_risk_amount numeric,p_risk_pct numeric,p_quote_to_usd numeric,
 p_quote_source text,p_quote_as_of timestamptz,p_trade_origin text default 'MANUAL',
 p_candle_as_of timestamptz default null,p_tp1 numeric default null,p_tp2 numeric default null,p_tp3 numeric default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_session public.demo_paper_sessions%rowtype;
 v_id uuid;
 v_daily_loss numeric;
 v_open_count integer;
 v_open_risk numeric;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 if p_user_id is null or p_session_id is null or p_instrument is null
   or p_side is null or p_side not in('BUY','SELL')
   or p_entry is null or p_entry<=0 or p_stop is null or p_stop<=0
   or p_target is null or p_target<=0 or p_quantity is null or p_quantity<=0
   or p_risk_amount is null or p_risk_amount<=0
   or p_risk_pct is null or p_risk_pct<=0 or p_risk_pct>2
   or p_quote_to_usd is null or p_quote_to_usd<=0
   or p_quote_source is distinct from 'DERIV'
   or p_quote_as_of is null or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
   or p_trade_origin is null or p_trade_origin not in('BOT','MANUAL') then
   raise exception 'Invalid or stale paper trade';
 end if;

 select * into v_session from public.demo_paper_sessions
  where id=p_session_id and user_id=p_user_id for update;
 if not found or v_session.status<>'RUNNING' then
   return jsonb_build_object('ok',false,'reason','SESSION_NOT_RUNNING');
 end if;
 if upper(v_session.instrument)<>upper(p_instrument) then
   return jsonb_build_object('ok',false,'reason','INSTRUMENT_MISMATCH');
 end if;
 if not ((p_side='BUY' and p_stop<p_entry and p_target>p_entry)
      or (p_side='SELL' and p_stop>p_entry and p_target<p_entry)) then
   raise exception 'Invalid stop/target placement';
 end if;
 if exists(select 1 from public.demo_paper_emergency_controls e
   where e.user_id=p_user_id and e.broker='DERIV'
     and e.broker_account_ref=v_session.broker_account_ref and e.entries_blocked) then
   return jsonb_build_object('ok',false,'reason','KILL_SWITCH_ACTIVE');
 end if;

 if p_risk_pct>v_session.risk_per_trade_pct
   or p_risk_amount>v_session.current_balance*v_session.risk_per_trade_pct/100
   or abs(p_risk_amount-abs(p_entry-p_stop)*p_quantity*p_quote_to_usd)>0.02 then
   raise exception 'Paper position risk does not match the server-approved session limits';
 end if;

 select count(*),
   coalesce(sum(risk_amount_usd*remaining_quantity/nullif(quantity,0)),0)
 into v_open_count,v_open_risk
 from public.demo_paper_trades
 where user_id=p_user_id and session_id=p_session_id and status='OPEN';

 if v_open_count>=v_session.max_open_positions then
   return jsonb_build_object('ok',false,'reason','MAX_OPEN_POSITIONS',
     'max_open_positions',v_session.max_open_positions);
 end if;
 if p_trade_origin='BOT' and exists(
   select 1 from public.demo_paper_trades
   where user_id=p_user_id and session_id=p_session_id
     and status='OPEN' and trade_origin='BOT'
 ) then
   return jsonb_build_object('ok',false,'reason','BOT_POSITION_EXISTS');
 end if;
 if v_open_risk+p_risk_amount > v_session.current_balance*v_session.max_total_open_risk_pct/100+0.000001 then
   return jsonb_build_object('ok',false,'reason','TOTAL_OPEN_RISK_LIMIT',
     'open_risk_usd',round(v_open_risk,2),
     'max_open_risk_usd',round(v_session.current_balance*v_session.max_total_open_risk_pct/100,2));
 end if;

 v_daily_loss := greatest(0,-coalesce((
   select sum(realized_pnl_usd) from public.demo_paper_trades
   where user_id=p_user_id
     and closed_at >= date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'
 ),0));
 if v_daily_loss >= v_session.starting_balance*v_session.max_daily_loss_pct/100 then
   update public.demo_paper_sessions
    set status='RISK_LOCKED',risk_locked_at=coalesce(risk_locked_at,now()),updated_at=now()
    where id=p_session_id;
   return jsonb_build_object('ok',false,'reason','DAILY_LOSS_LIMIT');
 end if;

 insert into public.demo_paper_trades(
   session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
   tp1_price,tp2_price,tp3_price,quantity,remaining_quantity,risk_amount_usd,
   risk_pct,quote_to_usd,quote_source,quote_as_of,candle_as_of,trade_origin
 ) values(
   p_session_id,p_user_id,p_instrument,p_side,p_entry,p_stop,p_target,
   p_tp1,p_tp2,p_tp3,p_quantity,p_quantity,p_risk_amount,
   p_risk_pct,p_quote_to_usd,p_quote_source,p_quote_as_of,p_candle_as_of,p_trade_origin
 ) returning id into v_id;

 update public.demo_paper_sessions
  set last_candle_as_of=coalesce(p_candle_as_of,last_candle_as_of),updated_at=now()
  where id=p_session_id;

 return jsonb_build_object(
   'ok',true,'trade_id',v_id,'status','OPEN','instrument',p_instrument,'side',p_side,
   'entry_price',p_entry,'stop_loss',p_stop,'take_profit',p_target,'quantity',p_quantity,
   'risk_amount_usd',p_risk_amount,'risk_pct',p_risk_pct,'opened_at',now(),
   'open_positions',v_open_count+1,'max_open_positions',v_session.max_open_positions,
   'remaining_open_risk_usd',round(v_open_risk+p_risk_amount,2)
 );
end;
$$;

comment on column public.demo_paper_sessions.max_open_positions is
 'Maximum simultaneous virtual positions in this DEMO session, including MANUAL and BOT positions.';
comment on column public.demo_paper_sessions.max_total_open_risk_pct is
 'Aggregate initial stop risk cap as a percentage of the virtual account balance; prevents stacking individually valid trades beyond the account risk budget.';
