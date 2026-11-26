-- Permit multiple independently validated entries within one M1 candle.
-- Candle identity remains intact; a separate tick-level key/timestamp provides
-- per-session idempotency and a one-second minimum spacing guard.
-- Feature-branch migration only; do not apply to production without approval.

alter table public.demo_scalping_preferences
  add column if not exists last_entry_quote_as_of timestamptz;
alter table public.demo_scalping_preferences
  add column if not exists last_entry_key text;

do $migration$
declare
  v_inner regprocedure := 'public.open_demo_scalping_paper_trade(uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,timestamptz)'::regprocedure;
  v_wrapper regprocedure := 'public.open_demo_scalping_paper_trade_with_lease(uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,timestamptz,timestamptz)'::regprocedure;
  v_sql text;
  v_before text;
begin
  v_sql := pg_get_functiondef(v_inner);
  v_before := v_sql;
  v_sql := regexp_replace(v_sql,
    'p_candle_as_of timestamp with time zone\s*\)',
    'p_candle_as_of timestamp with time zone,\n    p_entry_as_of timestamp with time zone,\n    p_entry_key text)', 'i');
  if v_sql = v_before then raise exception 'Could not extend scalping entry RPC signature'; end if;

  v_before := v_sql;
  v_sql := regexp_replace(v_sql,
    'or p_candle_as_of is null or p_candle_as_of > now\(\)\s+or p_candle_as_of < now\(\) - interval ''2 minutes'' then',
    'or p_candle_as_of is null or p_candle_as_of > now()\n     or p_candle_as_of < now() - interval ''2 minutes''\n     or p_entry_as_of is null or p_entry_as_of > now()\n     or p_entry_as_of < now() - interval ''10 seconds''\n     or p_entry_key is null or length(trim(p_entry_key)) not between 1 and 160 then', 'i');
  if v_sql = v_before then raise exception 'Could not add tick-level entry input validation'; end if;

  v_before := v_sql;
  v_sql := regexp_replace(v_sql,
    'if p_candle_as_of <= coalesce\(v_preference\.last_candle_as_of,''epoch''::timestamptz\) then\s+return jsonb_build_object\(''ok'',false,''reason'',''SCALPING_CANDLE_ALREADY_PROCESSED''\);\s+end if;',
    'if p_entry_key = coalesce(v_preference.last_entry_key, '''') then\n    return jsonb_build_object(''ok'',false,''reason'',''SCALPING_ENTRY_ALREADY_PROCESSED'');\n  end if;\n  if p_entry_as_of <= coalesce(v_preference.last_entry_quote_as_of, ''epoch''::timestamptz)\n     or p_entry_as_of < coalesce(v_preference.last_entry_quote_as_of, ''epoch''::timestamptz) + interval ''1 second'' then\n    return jsonb_build_object(''ok'',false,''reason'',''SCALPING_ENTRY_RATE_LIMIT'');\n  end if;', 'i');
  if v_sql = v_before then raise exception 'Could not replace M1-candle-only entry deduplication'; end if;

  v_before := v_sql;
  v_sql := replace(v_sql,
    'set last_candle_as_of=p_candle_as_of,updated_at=now()',
    'set last_candle_as_of=p_candle_as_of,last_entry_quote_as_of=p_entry_as_of,last_entry_key=p_entry_key,updated_at=now()');
  if v_sql = v_before then raise exception 'Could not persist tick-level idempotency state'; end if;

  v_before := v_sql;
  v_sql := replace(v_sql,
    '''scalping_candle_as_of'',p_candle_as_of)',
    '''scalping_candle_as_of'',p_candle_as_of,''scalping_entry_key'',p_entry_key,''scalping_entry_as_of'',p_entry_as_of)');
  if v_sql = v_before then raise exception 'Could not attach tick-level idempotency metadata'; end if;
  execute v_sql;

  v_sql := pg_get_functiondef(v_wrapper);
  v_before := v_sql;
  v_sql := regexp_replace(v_sql,
    'p_candle_as_of timestamp with time zone\s*\)',
    'p_candle_as_of timestamp with time zone,\n    p_entry_as_of timestamp with time zone,\n    p_entry_key text)', 'i');
  if v_sql = v_before then raise exception 'Could not extend lease wrapper signature'; end if;

  v_before := v_sql;
  v_sql := replace(v_sql,
    'p_quote_as_of,p_candle_as_of\n  );',
    'p_quote_as_of,p_candle_as_of,p_entry_as_of,p_entry_key\n  );');
  if v_sql = v_before then
    v_sql := regexp_replace(v_sql,
      'p_quote_as_of,p_candle_as_of\s*\);',
      'p_quote_as_of,p_candle_as_of,p_entry_as_of,p_entry_key);', 'i');
  end if;
  if v_sql = v_before then raise exception 'Could not forward tick-level idempotency values through lease wrapper'; end if;
  execute v_sql;
end;
$migration$;

revoke all on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz
) from public, anon, authenticated, service_role;

revoke all on function public.open_demo_scalping_paper_trade(
  uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz,timestamptz,text
) from public, anon, authenticated, service_role;

revoke all on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz,timestamptz,text
) from public, anon, authenticated;
grant execute on function public.open_demo_scalping_paper_trade_with_lease(
  uuid,uuid,uuid,text,text,numeric,numeric,numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,timestamptz,timestamptz,timestamptz,text
) to service_role;

comment on column public.demo_scalping_preferences.last_entry_quote_as_of
  is 'Latest accepted tick timestamp for Quantum Scalping entry pacing; separate from M1 candle timestamp.';
comment on column public.demo_scalping_preferences.last_entry_key
  is 'Deterministic per-session tick idempotency key for Quantum Scalping paper entries.';
