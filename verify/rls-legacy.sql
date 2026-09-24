-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it. Without it the guard raises, psql
-- shrugs, and the DELETEs below run anyway — which is the entire failure
-- this is meant to prevent. In the Supabase SQL editor the RAISE aborts the
-- surrounding transaction on its own, so nothing after it commits there.
\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE DELETES ROWS. It is for a THROWAWAY Postgres, never for      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- #                                                                        #
-- #  The guard below is not documentation. Pasting this file into the       #
-- #  Supabase SQL editor raises before it touches anything, because only a  #
-- #  database built by a verify/*-fixture.sql has the marker table it       #
-- #  looks for.                                                             #
-- #                                                                        #
-- #  It exists because "run db/sms-delivery.sql, not                        #
-- #  verify/sms-delivery.sql" is a one-character distinction, and a         #
-- #  one-character distinction should never be the only thing standing      #
-- #  between a paste and an empty leads table.                              #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it deletes rows. It only '
      'runs against a scratch database built by the matching '
      'verify/*-fixture.sql, which creates public._scratch_db. If you meant '
      'to apply a migration, the file you want is in db/.';
  end if;
end $$;

-- verify/rls-legacy.sql
--
-- Reproduces the state the LIVE database was actually in, which the first
-- version of verify/rls.sql knew nothing about and therefore passed.
--
-- Run between the fixture and db/rls-phase-1.sql:
--
--   psql -f verify/rls-fixture.sql -f verify/rls-legacy.sql \
--        -f db/rls-phase-1.sql -f db/rls-phase-1b.sql -f verify/rls.sql
--
-- *** NEVER RUN THIS AGAINST SUPABASE. ***
--
-- ===========================================================================
-- What this is
-- ===========================================================================
--
-- Supabase's dashboard has a one-click "enable read/write access for
-- authenticated users" button, and somebody had used it on these tables at
-- some point. It creates a policy like the ones below and leaves it there.
--
-- With RLS switched OFF those policies are inert — they exist, they do
-- nothing, and `select ... from pg_policies` is the only place they show up.
-- So the tables looked unprotected, which they were, and the policies were
-- invisible in every other sense.
--
-- The moment db/rls-phase-1.sql turned RLS on, they woke up.
--
-- ===========================================================================
-- Why that breaks the new rules
-- ===========================================================================
--
-- Postgres combines PERMISSIVE policies with OR, not AND. Two policies on
-- DELETE means "allowed if EITHER says yes". So:
--
--     leads_admin_delete            -> delete allowed when sb_is_admin()
--     "authenticated full access"   -> delete allowed, full stop
--
-- ...grants every signed-in user the delete that the first policy exists to
-- prevent. A restrictive policy is not a restriction when a permissive one
-- sits beside it. The same applies to the profiles rules.
--
-- This is the single easiest way to believe a database is locked down when
-- it is not, because both policies read as correct on their own.

create policy "authenticated full access to leads" on public.leads
  for all to authenticated using (true) with check (true);

create policy "authenticated full access to jobs" on public.jobs
  for all to authenticated using (true) with check (true);

create policy "authenticated full access to customers" on public.customers
  for all to authenticated using (true) with check (true);

create policy "authenticated full access to job_assignments" on public.job_assignments
  for all to authenticated using (true) with check (true);

create policy "authenticated can read profiles" on public.profiles
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- And the other thing the live database has: a view
-- ---------------------------------------------------------------------------
--
-- `lead_status_age` powers the stale-lead badge on the Leads board. It is a
-- VIEW over leads, and the grants query showed anon holding SELECT on it.
--
-- A view does not have policies of its own. By default it runs with the
-- privileges of whoever OWNS it, not whoever queries it — so RLS on the
-- underlying table is evaluated as the owner, who bypasses it. Every lead is
-- readable through the view by anyone the view is granted to, no matter how
-- locked down `leads` is.
--
-- Locking a table and leaving a view over it open is a door with a window
-- beside it.

create or replace view public.lead_status_age as
  select l.id, l.name, l.status, l.created_by
    from public.leads l;

grant select on public.lead_status_age to anon, authenticated;
