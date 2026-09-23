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
