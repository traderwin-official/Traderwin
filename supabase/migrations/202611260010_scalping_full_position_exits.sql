-- Quantum scalping uses one full-position take-profit. Manual staged exits remain unchanged.
create or replace function public.close_demo_scalping_paper_trade(
 p_user_id uuid,p_trade_id uuid,p_reason text,p_exit_price numeric,
 p_quote_to_usd numeric,p_quote_source text,p_quote_as_of timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_trade public.demo_paper_trades%rowtype;
 v_qty numeric(28,12);v_pnl numeric(18,2);v_balance numeric(18,2);
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_reason is null or p_reason not in('TAKE_PROFIT','STOP_LOSS') or p_exit_price is null or p_exit_price<=0
   or p_quote_to_usd is null or p_quote_to_usd<=0 or p_quote_source is distinct from 'DERIV'
   or p_quote_as_of is null or p_quote_as_of>now() or p_quote_as_of<now()-interval '30 seconds'
 then raise exception 'Invalid or stale full-position scalping exit'; end if;
 select * into v_trade from public.demo_paper_trades
  where id=p_trade_id and user_id=p_user_id and status='OPEN' for update;
 if not found then return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN'); end if;
 if v_trade.trade_origin<>'BOT' or v_trade.metadata->>'strategy'<>'TIGER_SCHEME_QUANTUM_SCALPING'
 then return jsonb_build_object('ok',false,'reason','NOT_A_SCALPING_BOT_POSITION'); end if;
 if p_reason='STOP_LOSS' and not (
   (v_trade.side='BUY' and p_exit_price<=v_trade.stop_loss) or
   (v_trade.side='SELL' and p_exit_price>=v_trade.stop_loss))
 then return jsonb_build_object('ok',false,'reason','STOP_LOSS_NOT_REACHED'); end if;
 if p_reason='TAKE_PROFIT' and not (
   (v_trade.side='BUY' and p_exit_price>=v_trade.take_profit) or
   (v_trade.side='SELL' and p_exit_price<=v_trade.take_profit))
 then return jsonb_build_object('ok',false,'reason','TAKE_PROFIT_NOT_REACHED'); end if;
 v_qty:=v_trade.remaining_quantity;
 if v_qty is null or v_qty<=0 then return jsonb_build_object('ok',false,'reason','INVALID_REMAINING_QUANTITY'); end if;
 v_pnl:=round((case when v_trade.side='BUY' then p_exit_price-v_trade.entry_price else v_trade.entry_price-p_exit_price end)*v_qty*p_quote_to_usd,2);
 update public.demo_paper_trades set remaining_quantity=0,realized_pnl_usd=realized_pnl_usd+v_pnl,
  last_mark_price=p_exit_price,last_mark_at=p_quote_as_of,status='CLOSED',closed_at=now()
  where id=v_trade.id and status='OPEN';
 if not found then return jsonb_build_object('ok',false,'reason','TRADE_NOT_OPEN'); end if;
 update public.demo_paper_sessions set current_balance=greatest(0,current_balance+v_pnl),
  status=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades
   where session_id=v_trade.session_id and closed_at>=date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'))
   >=starting_balance*max_daily_loss_pct/100 then 'RISK_LOCKED' else status end,
  risk_locked_at=case when greatest(0,-(select coalesce(sum(realized_pnl_usd),0) from public.demo_paper_trades
   where user_id=p_user_id and closed_at>=date_trunc('day',now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'))
   >=starting_balance*max_daily_loss_pct/100 then coalesce(risk_locked_at,now()) else risk_locked_at end,
  updated_at=now() where id=v_trade.session_id returning current_balance into v_balance;
 return jsonb_build_object('ok',true,'reason',p_reason,'trade_id',v_trade.id,'closed',true,
  'closed_units',v_qty,'remaining_units',0,'realized_pnl_this_exit',v_pnl,
  'realized_pnl_total',v_trade.realized_pnl_usd+v_pnl,'balance',v_balance);
end $$;

create or replace function public.close_demo_scalping_paper_trade_with_lease(
 p_lease_token uuid,p_user_id uuid,p_trade_id uuid,p_reason text,p_exit_price numeric,
 p_quote_to_usd numeric,p_quote_source text,p_quote_as_of timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_lease public.scalping_worker_leases%rowtype;
begin
 if auth.role() is distinct from 'service_role' or p_lease_token is null then
  raise exception 'Service role and current scalping worker lease required'; end if;
 select * into v_lease from public.scalping_worker_leases where lease_key='global' for update;
 if not found or v_lease.lease_token is distinct from p_lease_token
  or v_lease.lease_until is null or v_lease.lease_until<=clock_timestamp()
 then return jsonb_build_object('ok',false,'reason','SCALPING_WORKER_LEASE_NOT_OWNED'); end if;
 return public.close_demo_scalping_paper_trade(p_user_id,p_trade_id,p_reason,p_exit_price,p_quote_to_usd,p_quote_source,p_quote_as_of);
end $$;

revoke all on function public.close_demo_scalping_paper_trade(uuid,uuid,text,numeric,numeric,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.close_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz) from public,anon,authenticated;
grant execute on function public.close_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz) to service_role;
comment on function public.close_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz)
 is 'Lease-fenced atomic full-position DEMO scalping exit at one take-profit or stop-loss. Never manages manual positions or sends broker orders.';

-- Disable the retired staged-exit endpoint. Scalping now closes full positions
-- through the single-target RPC above; manual partial-exit RPCs are unaffected.
revoke all on function public.manage_demo_scalping_paper_exit_with_lease(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz)
 from public,anon,authenticated,service_role;
