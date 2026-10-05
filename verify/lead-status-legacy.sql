-- The state the database was actually in, before db/lead-status-constraint.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. It alters tables in a throwaway        #
-- #  stand-in schema. db/*.sql are the real migrations; verify/*.sql are not. #
-- ############################################################################
--
-- Seeds the OLD constraint rather than letting the test write its own copy of
-- the new one. The difference matters: a suite that pastes the migration's own
-- statement into itself stays green when somebody deletes the migration. This
-- recreates the bug, so the assertions afterwards are testing the fix.
--
-- Run order:
--   verify/sms-fixture.sql
--   verify/lead-status-legacy.sql   <- this
--   db/lead-status-constraint.sql
--   verify/lead-status.sql

\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it alters tables. It only '
      'runs against a scratch database built by verify/sms-fixture.sql.';
  end if;
end $$;

alter table public.leads drop constraint if exists leads_status_check;

-- Written before 'lost' and 'archived' existed. This is the constraint
-- db/lead-events.sql found, raised a NOTICE about, and deliberately left
-- alone -- and the NOTICE scrolled past above the Supabase result grid.
alter table public.leads
  add constraint leads_status_check
  check (status in ('new', 'contacted', 'quoted', 'booked', 'scheduled', 'completed'));
