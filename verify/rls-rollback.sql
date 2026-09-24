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

-- verify/rls-rollback.sql — does the panic button actually work?
--
--   psql -f verify/rls-fixture.sql -f db/rls-phase-1.sql -f verify/rls.sql \
--        -f db/rls-phase-1-rollback.sql -f verify/rls-rollback.sql
--
-- *** The fixture drops tables. NEVER run this against Supabase. ***
--
-- A rollback script nobody has run is a wish. This applies the migration,
-- runs the full suite against it, rolls back, and then checks the three
-- things that have to be true afterwards: the CRM works again, the guard is
-- gone, and anon can read again — which is the price of rolling back, stated
-- out loud so it can't be forgotten while the site sits in that state.

-- Inserts its own row first: verify/rls.sql runs before this and deletes the
-- quoted lead as part of testing the admin-delete policy, so anything that
-- assumes the fixture's rows are still there is testing the previous file.
insert into leads (id, name, status) values
  ('dddddddd-0000-0000-0000-000000000001', 'Rollback test', 'quoted');

do $$
begin
  perform chk('rollback: anon can read leads again (this is the cost)',
    visible('anon', null, 'leads') >= 1);
  perform chk('rollback: a tech can delete a lead again',
    not blocked('authenticated', '33333333-3333-3333-3333-333333333333',
      $q$delete from public.leads where id = 'dddddddd-0000-0000-0000-000000000001'$q$));
  perform chk('rollback: the role guard is gone',
    not blocked('authenticated', '22222222-2222-2222-2222-222222222222',
      $q$update public.profiles set role = 'admin'
          where id = '22222222-2222-2222-2222-222222222222'$q$));
  raise notice '';
  raise notice 'rollback verified - the CRM is fully usable again';
end $$;
