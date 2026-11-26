-- Carry the virtual DEMO account balance across separate trading sessions.
-- This reads the append-only realized P/L already stored in the isolated paper ledger.
create or replace function public.get_demo_paper_account_balance(p_user_id uuid)
returns numeric(18,2)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance numeric(18,2);
begin
  if auth.role() <> 'service_role' or p_user_id is null then
    raise exception 'Service role required';
  end if;
  select round(10000 + coalesce(sum(realized_pnl_usd),0),2)
    into v_balance
    from public.demo_paper_trades
   where user_id = p_user_id;
  return greatest(0,coalesce(v_balance,10000));
end;
$$;

revoke all on function public.get_demo_paper_account_balance(uuid)
  from public, anon, authenticated;
grant execute on function public.get_demo_paper_account_balance(uuid)
  to service_role;

comment on function public.get_demo_paper_account_balance(uuid) is
'Returns the member DEMO account balance as USD 10,000 starting virtual funds plus all realized P/L across every DEMO paper session. Service-role only.';
