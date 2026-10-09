-- lingua_v31_suggestions_and_admin
--
-- NOT YET APPLIED. Prepared 2026-10-10, held back because applying it needs
-- an approval nobody was awake to give.
--
-- Apply this BEFORE shipping the client code that reads it — every migration
-- in this project has gone first, so an older client can never hit a column
-- that is not there. After applying, make yourself the admin:
--
--   update public.user_settings set is_admin = true
--   where user_id = (select id from auth.users where email = 'mrp611@gmail.com');
--
-- There is deliberately no way to grant that flag from inside the app.

alter table public.user_settings
  add column if not exists is_admin boolean not null default false;

comment on column public.user_settings.is_admin is
  'Set by hand in the dashboard. There is deliberately no way to grant this from the app.';

create table if not exists public.suggestions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  -- Which screen it was sent from, so a report about Test is not read as one
  -- about Reading. Free text, filled by the client.
  context text,
  -- new -> read -> done, or dismissed. Only an admin may move it.
  status text not null default 'new'
    check (status in ('new', 'read', 'done', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists suggestions_created_idx
  on public.suggestions (created_at desc);
create index if not exists suggestions_user_idx
  on public.suggestions (user_id, created_at desc);

alter table public.suggestions enable row level security;

-- Is the caller an admin?
--
-- SECURITY DEFINER so it reads user_settings with RLS bypassed. Without that
-- a policy on suggestions that consults user_settings would be evaluated
-- under the caller's own policies, and an admin policy that depends on a
-- table the caller can only partly see is a policy that silently does
-- nothing. search_path is pinned because a SECURITY DEFINER function with a
-- caller-controlled search_path is an escalation route.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    (select s.is_admin from public.user_settings s where s.user_id = auth.uid()),
    false
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

drop policy if exists suggestions_insert_own on public.suggestions;
create policy suggestions_insert_own on public.suggestions
  for insert to authenticated
  with check (user_id = auth.uid());

-- You can see what you sent; an admin can see everything.
drop policy if exists suggestions_select on public.suggestions;
create policy suggestions_select on public.suggestions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only an admin triages. A user editing their own suggestion after the fact
-- would mean the thing you read is not the thing they sent.
drop policy if exists suggestions_update_admin on public.suggestions;
create policy suggestions_update_admin on public.suggestions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists suggestions_delete_admin on public.suggestions;
create policy suggestions_delete_admin on public.suggestions
  for delete to authenticated
  using (public.is_admin());

-- Aggregate numbers for the admin panel.
--
-- Counting every user's rows is exactly what RLS exists to prevent, so this
-- is the one sanctioned hole: SECURITY DEFINER, admin-gated on its first
-- line, and it returns only totals — never a row, a word or an email.
create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'users', (select count(*) from auth.users),
    'users_active_7d', (
      select count(distinct user_id) from public.review_log
      where reviewed_at > now() - interval '7 days'
    ),
    'concepts', (select count(*) from public.concepts where deleted_at is null),
    'entries', (select count(*) from public.entries),
    'cards', (select count(*) from public.cards),
    'reviews', (select count(*) from public.review_log),
    'stories', (select count(*) from public.stories where deleted_at is null),
    'suggestions_new', (
      select count(*) from public.suggestions where status = 'new'
    ),
    -- Total on-disk size of the tables this app owns, which is the number
    -- that decides whether the free tier still fits.
    'db_bytes', (
      select coalesce(sum(pg_total_relation_size(c.oid)), 0)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;
