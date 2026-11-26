-- Verify authenticated DEMO users can read only their own paper sessions and
-- worker heartbeats. Uses only the disposable PostgreSQL CI database.
begin;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

set local role service_role;
insert into public.demo_paper_sessions
  (id,user_id,broker,broker_account_ref,instrument,strategy,timeframe,status)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','DERIV','demo-A','frxEURUSD','test','M15','RUNNING'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','DERIV','demo-B','frxGBPUSD','test','M15','RUNNING')
on conflict (id) do nothing;

insert into public.demo_paper_worker_heartbeats
  (session_id,user_id,last_tick_at,last_action)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',now(),'TEST'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222',now(),'TEST')
on conflict (session_id) do nothing;

insert into public.demo_paper_trades
  (id,session_id,user_id,instrument,side,entry_price,stop_loss,take_profit,
   quantity,remaining_quantity,risk_amount_usd,risk_pct,quote_to_usd,
   quote_source,quote_as_of,trade_origin,status)
values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','frxEURUSD','BUY',1.1000,1.0900,1.1200,1,1,10,0.50,1,'DERIV',now(),'BOT','OPEN'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','frxGBPUSD','BUY',1.2500,1.2400,1.2700,1,1,10,0.50,1,'DERIV',now(),'BOT','OPEN')
on conflict (id) do nothing;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);

do $$
begin
  if (select count(*) from public.demo_paper_sessions) <> 1
     or not exists (select 1 from public.demo_paper_sessions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
     or exists (select 1 from public.demo_paper_sessions where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') then
    raise exception 'User A can see another user''s DEMO session or cannot see their own';
  end if;

  if (select count(*) from public.demo_paper_worker_heartbeats) <> 1
     or not exists (select 1 from public.demo_paper_worker_heartbeats where session_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
     or exists (select 1 from public.demo_paper_worker_heartbeats where session_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') then
    raise exception 'User A can see another user''s worker heartbeat or cannot see their own';
  end if;

  if (select count(*) from public.demo_paper_trades) <> 1
     or not exists (select 1 from public.demo_paper_trades where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')
     or exists (select 1 from public.demo_paper_trades where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') then
    raise exception 'User A can see another user''s DEMO trade or cannot see their own';
  end if;

  if has_table_privilege('authenticated','public.demo_paper_sessions','INSERT')
     or has_table_privilege('authenticated','public.demo_paper_sessions','UPDATE')
     or has_table_privilege('authenticated','public.demo_paper_sessions','DELETE')
     or has_table_privilege('authenticated','public.demo_paper_worker_heartbeats','INSERT')
     or has_table_privilege('authenticated','public.demo_paper_worker_heartbeats','UPDATE')
     or has_table_privilege('authenticated','public.demo_paper_worker_heartbeats','DELETE') then
    raise exception 'Authenticated users must not directly mutate worker-owned DEMO records';
  end if;
end
$$;

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$
begin
  if (select count(*) from public.demo_paper_sessions) <> 1
     or not exists (select 1 from public.demo_paper_sessions where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
     or exists (select 1 from public.demo_paper_sessions where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then
    raise exception 'User B can see another user''s DEMO session or cannot see their own';
  end if;

  if (select count(*) from public.demo_paper_trades) <> 1
     or not exists (select 1 from public.demo_paper_trades where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')
     or exists (select 1 from public.demo_paper_trades where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc') then
    raise exception 'User B can see another user''s DEMO trade or cannot see their own';
  end if;
end
$$;

reset role;
rollback;
