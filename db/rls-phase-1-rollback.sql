-- db/rls-phase-1-rollback.sql
--
-- Undo db/rls-phase-1.sql. Paste and run; it takes effect immediately.
--
-- WHEN TO USE THIS: the CRM has gone wrong in a way that is costing you work
-- right now — a page is empty, a save is failing, the crew is stood at a
-- house unable to record a job. Run it, get working, and we diagnose after.
-- A CRM used from a ladder is not the place to debug a policy.
--
-- WHAT IT COSTS: the five tables go back to being readable by anyone holding
-- the anon key, which is published in the website's JavaScript. That is the
-- state they were in for months, so it is survivable for an afternoon — but
-- it is not somewhere to sit indefinitely.
--
-- WHAT IT KEEPS: the tables that already had RLS before this migration
-- (quotes, commissions, lead_events, job_events, contact_log, follow_ups,
-- sms_messages, sms_opt_outs) are untouched here and stay protected.
-- sb_is_admin() and sb_role() are left in place too — commissions.sql
-- depends on sb_is_admin(), so dropping it would break the Commission page.
--
-- BEFORE YOU RUN IT, if you have ten seconds: note which page failed and
-- what the error said. "Nothing worked" is much harder to fix afterwards
-- than "the map was empty and the console said 42501".

alter table public.leads            disable row level security;
alter table public.jobs             disable row level security;
alter table public.customers        disable row level security;
alter table public.job_assignments  disable row level security;
alter table public.profiles         disable row level security;

-- The policies are left defined but inert — disabling RLS switches them off
-- without deleting them, so re-running db/rls-phase-1.sql puts everything
-- back exactly as it was rather than rebuilding from scratch.

-- The one piece that is NOT row-level security, and so has to be removed
-- separately: the trigger stopping a rep editing their own role and rates.
-- It is dropped here too, because a rollback should leave one state, not a
-- half-applied one that behaves differently from both.
drop trigger if exists profiles_guard_privileges on public.profiles;

do $$
begin
  raise notice '';
  raise notice 'RLS is OFF again for leads, jobs, customers, job_assignments, profiles.';
  raise notice 'The role/commission guard on profiles is also removed.';
  raise notice 'Everything that had RLS before rls-phase-1.sql is untouched.';
  raise notice '';
end;
$$;
