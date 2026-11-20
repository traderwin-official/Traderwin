-- Disposable PostgreSQL verification for the additive Deriv account-picker migration.
do $$
declare
  required_columns text[] := array['accounts','token_type','requested_scopes','connected_at'];
  required_name text;
begin
  foreach required_name in array required_columns loop
    if not exists (
      select 1
      from information_schema.columns c
      where c.table_schema='public'
        and c.table_name='deriv_connections'
        and c.column_name=required_name
    ) then
      raise exception 'Missing deriv_connections column: %', required_name;
    end if;
  end loop;
end
$$;

insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111')
on conflict do nothing;

insert into public.deriv_connections(
  user_id, encrypted_access_token, accounts, requested_scopes, connected_at
) values (
  '11111111-1111-4111-8111-111111111111',
  'encrypted-test-token',
  '[{"account_id":"VRTC123","account_type":"demo","status":"active"}]'::jsonb,
  '["trade","account_manage"]'::jsonb,
  now()
);

do $$
begin
  if (select jsonb_array_length(accounts) from public.deriv_connections
      where user_id='11111111-1111-4111-8111-111111111111') <> 1 then
    raise exception 'Deriv verified account metadata was not persisted';
  end if;
  if (select requested_scopes @> '["trade","account_manage"]'::jsonb
      from public.deriv_connections
      where user_id='11111111-1111-4111-8111-111111111111') is not true then
    raise exception 'Deriv requested scopes were not persisted';
  end if;
end
$$;
