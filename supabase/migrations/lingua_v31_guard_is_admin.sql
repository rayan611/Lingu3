-- lingua_v31_guard_is_admin
--
-- RUN THIS. It closes a privilege-escalation hole opened by the previous
-- migration. Applying it from here was refused twice, so it needs running by
-- hand in the Supabase SQL editor.
--
-- The hole: the RLS policy on user_settings is a single ALL policy on
-- `auth.uid() = user_id`. That is right for every other column and wrong for
-- is_admin — any signed-in account can PATCH its own row with
-- is_admin = true using the publishable key that ships in the browser bundle,
-- then call admin_stats() and read every user's suggestions. The v31
-- migration's own comment claimed there was no way to grant the flag from the
-- app. There was.
--
-- A BEFORE trigger rather than column privileges, because restricting one
-- column by GRANT means revoking table-level UPDATE and re-granting the other
-- eight by name — which silently breaks the next time a column is added.
--
-- SECURITY INVOKER (the default) is load-bearing: under SECURITY DEFINER
-- current_user would be the function owner and the check would never fire.
-- PostgREST runs as `authenticated` or `anon`; the SQL editor runs as the
-- owner, which is how the flag is meant to be set.

create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Not an error: the app inserts this row on first sign-in and has no
    -- opinion about the flag. Just never let it arrive true.
    new.is_admin := false;
    return new;
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception 'is_admin cannot be changed from the app'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_is_admin on public.user_settings;
create trigger guard_is_admin
  before insert or update on public.user_settings
  for each row execute function public.guard_is_admin();

comment on column public.user_settings.is_admin is
  'Set only from the SQL editor or another owner-role connection. The guard_is_admin trigger rejects any change made through PostgREST.';

-- Verify afterwards: this should return exactly one row, yours.
--   select u.email, s.is_admin from public.user_settings s
--   join auth.users u on u.id = s.user_id where s.is_admin;

-- Keep both functions off the anonymous API surface.
--
-- The v31 migration did `revoke all ... from public`, which does not touch an
-- explicit grant — and Supabase's default privileges grant EXECUTE on every
-- new function in `public` to anon, authenticated and service_role. So
-- /rest/v1/rpc/admin_stats was reachable without signing in. It refused
-- (auth.uid() is null, so is_admin() is false), but a gate nobody can reach
-- is better than a gate that holds.
revoke execute on function public.is_admin() from anon;
revoke execute on function public.admin_stats() from anon;
