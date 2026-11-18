-- Young Tiger FX: constrain browser-managed bot profiles to safe DEMO configuration.
-- Existing profiles and trade history are preserved. This migration only replaces one policy
-- and narrows browser table privileges; bot execution remains server-controlled.

begin;

drop policy if exists "Users manage own bot mode profiles" on public.bot_mode_profiles;

create policy "Users manage own DEMO bot mode profiles"
on public.bot_mode_profiles
for all
to authenticated
using (
  auth.uid() = user_id
  and account_mode = 'DEMO'
  and enabled = false
)
with check (
  auth.uid() = user_id
  and account_mode = 'DEMO'
  and enabled = false
);

revoke all on public.bot_mode_profiles from anon, authenticated;
grant select, insert, update
on public.bot_mode_profiles
to authenticated;

comment on table public.bot_mode_profiles is
  'Per-user bot preferences. Browser clients may manage DEMO profiles only with enabled=false; execution and REAL authorization are server-controlled.';

commit;
