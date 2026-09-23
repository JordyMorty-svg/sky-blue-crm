-- db/rls-phase-1b.sql
--
-- Run AFTER db/rls-phase-1.sql. Safe to re-run.
-- Rollback: db/rls-phase-1-rollback.sql covers both files.
--
-- ===========================================================================
-- Why there is a 1b
-- ===========================================================================
--
-- Phase 1 was written against the migration files, which is not the same
-- thing as the database. Reading the live one turned up two things that
-- quietly cancelled parts of it.
--
-- 1. OLD BLANKET POLICIES WERE ALREADY THERE, ASLEEP.
--
--    Supabase's dashboard has a one-click "enable access for authenticated
--    users" button. Somebody had used it on leads, jobs, customers,
--    job_assignments and profiles, leaving policies called things like
--    "authenticated full access to leads".
--
--    With RLS switched OFF those do nothing at all, and pg_policies is the
--    only place they appear — so the tables looked bare, which they were.
--    Turning RLS on in phase 1 woke them up.
--
--    Postgres combines permissive policies with OR. So:
--
--        leads_admin_delete           -> delete allowed when sb_is_admin()
--        "authenticated full access"  -> delete allowed, full stop
--
--    ...means any signed-in user can still delete. The owners-only rules
--    from phase 1 were being granted away by a policy written months
--    earlier. Both read as correct on their own, which is what makes this
--    worth a comment this long.
--
-- 2. A VIEW OVER leads, READABLE BY anon.
--
--    `lead_status_age` powers the stale-lead badge on the Leads board. A
--    view has no policies of its own and by default runs as its OWNER, who
--    bypasses RLS. Granting it to anon hands out every lead it selects,
--    however locked down `leads` is. A locked table with an open view over
--    it is a door with a window beside it.

-- ---------------------------------------------------------------------------
-- 1. Remove any policy on these tables that phase 1 did not create
-- ---------------------------------------------------------------------------
--
-- Dropped by "not in the known list" rather than by name. The blanket
-- policies are named inconsistently — the dashboard names them after
-- whatever it felt like at the time — and one that got missed because its
-- name was slightly different from the one written here would leave the hole
-- open while this file reported success.

do $$
declare
  p record;
  keep text[] := array[
    'leads_staff_read', 'leads_staff_insert', 'leads_staff_update',
    'leads_admin_delete', 'leads_public_insert',
    'jobs_staff_read', 'jobs_staff_insert', 'jobs_staff_update',
    'jobs_admin_delete',
    'customers_staff_read', 'customers_staff_insert', 'customers_staff_update',
    'customers_admin_delete',
    'job_assignments_staff_read', 'job_assignments_staff_write',
    'job_assignments_staff_update', 'job_assignments_staff_delete',
    'profiles_staff_read', 'profiles_self_or_admin_update',
    'profiles_self_insert'
  ];
  dropped int := 0;
begin
  for p in
    select policyname, tablename
      from pg_policies
     where schemaname = 'public'
       and tablename in ('leads','jobs','customers','job_assignments','profiles')
       and policyname <> all (keep)
     order by tablename, policyname
  loop
    raise notice 'Dropping leftover policy "%" on %', p.policyname, p.tablename;
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
    dropped := dropped + 1;
  end loop;

  if dropped = 0 then
    raise notice 'No leftover policies found — nothing to drop.';
  else
    raise notice '% leftover policies removed.', dropped;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Close the views
-- ---------------------------------------------------------------------------
--
-- Two changes, because either alone leaves a gap:
--
--   security_invoker  — the view is evaluated as whoever queries it, so RLS
--                       on the underlying table finally applies. This is
--                       what stops a signed-in user reading rows through a
--                       view that they could not read from the table.
--   revoke from anon  — belt and braces. The public website never reads a
--                       view; it only inserts a lead. Nothing anonymous has
--                       any business here.
--
-- security_invoker needs Postgres 15. Supabase is well past that, but the
-- version is checked rather than assumed: on an older server this would
-- error out mid-file and leave half the work done.

do $$
declare
  v record;
  can_invoke boolean := current_setting('server_version_num')::int >= 150000;
  n int := 0;
begin
  if not can_invoke then
    raise notice 'Postgres < 15: security_invoker unavailable, revoking from anon only.';
  end if;

  for v in
    select table_name
      from information_schema.views
     where table_schema = 'public'
     order by table_name
  loop
    if can_invoke then
      execute format('alter view public.%I set (security_invoker = true)', v.table_name);
    end if;
    execute format('revoke all on public.%I from anon', v.table_name);
    raise notice 'View %: now evaluated as the caller, and anon revoked.', v.table_name;
    n := n + 1;
  end loop;

  if n = 0 then
    raise notice 'No views in public.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Say plainly who can delete what
-- ---------------------------------------------------------------------------
--
-- The check that would have caught this in the first place. It reports the
-- policies that permit DELETE per table, so "owners only" can be READ rather
-- than assumed — a second permissive policy shows up here immediately.

do $$
declare
  r record;
begin
  raise notice '';
  raise notice 'DELETE is permitted by these policies:';
  for r in
    select tablename, policyname, qual::text as condition
      from pg_policies
     where schemaname = 'public'
       and tablename in ('leads','jobs','customers','job_assignments','profiles')
       and cmd in ('DELETE', 'ALL')
     order by tablename, policyname
  loop
    raise notice '  %  %  ->  %',
      rpad(r.tablename, 16), rpad(r.policyname, 30), coalesce(r.condition, '(none)');
  end loop;
  raise notice '';
  raise notice 'Anything reading "true" for leads, jobs or customers is a';
  raise notice 'problem — those three should say sb_is_admin().';
  raise notice '';
end;
$$;
