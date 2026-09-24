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

-- verify/rls.sql — does db/rls-phase-1.sql actually hold?
--
--   psql -f verify/rls-fixture.sql -f db/rls-phase-1.sql -f verify/rls.sql
--
-- *** The fixture drops tables. NEVER run this against Supabase. ***
--
-- Everything here runs AS anon or AS authenticated, with auth.uid() pointed
-- at a real test profile. A policy can only be trusted if something has
-- tried to get past it.
--
-- The assertions marked THE POINT are the reasons this migration exists.

\set ON_ERROR_STOP on
\pset pager off

create or replace function chk(what text, pass boolean, detail text default '')
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  % %', what, coalesce(detail, '');
  end if;
end $$;

-- Runs `sql` as `who`, with auth.uid() set to `uid`, and reports whether it
-- got anywhere.
--
-- "Blocked" has to mean two different things, and missing the second one is
-- the mistake this helper was written wrong the first time:
--
--   * RAISED AN ERROR — what an INSERT does when it fails a WITH CHECK, and
--     what the profiles trigger does deliberately.
--   * CHANGED NOTHING — what an UPDATE or DELETE does when RLS refuses. It
--     does NOT error. The rows are filtered out before the statement sees
--     them, so `delete from leads` by a tech succeeds, deletes nothing, and
--     returns a cheerful success. A test that only catches exceptions marks
--     that as "not blocked" and passes on a policy that is working.
--
-- Every statement below matches at least one row when permitted, so "zero
-- rows" here is never ambiguous.
create or replace function blocked(who text, uid text, sql text)
returns boolean language plpgsql as $$
declare
  n integer;
begin
  begin
    execute format('set local role %I', who);
    perform set_config('test.uid', coalesce(uid, ''), true);
    execute sql;
    get diagnostics n = row_count;
    execute 'reset role';
    return n = 0;
  exception
    when others then
      execute 'reset role';
      return true;
  end;
end $$;

-- How many rows `who` can actually see in `tbl`.
--
-- Returns 0 when the read is refused outright, because there are two ways to
-- see nothing and the question here does not care which:
--
--   * RLS filtered every row away — the read succeeds, returns 0.
--   * The GRANT was revoked — the read raises "permission denied".
--
-- db/rls-phase-1b.sql revokes anon's access to views, so the view assertions
-- take the second path while the table assertions take the first. Treating
-- an exception as anything other than "saw nothing" made this suite error
-- out on a view that was correctly locked.
create or replace function visible(who text, uid text, tbl text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('set local role %I', who);
  perform set_config('test.uid', coalesce(uid, ''), true);
  execute format('select count(*) from public.%I', tbl) into n;
  execute 'reset role';
  return n;
exception
  when others then
    execute 'reset role';
    return 0;
end $$;

\set ADMIN   '''11111111-1111-1111-1111-111111111111'''
\set PARTNER '''22222222-2222-2222-2222-222222222222'''
\set TECH    '''33333333-3333-3333-3333-333333333333'''

do $$
declare
  admin_id   text := '11111111-1111-1111-1111-111111111111';
  partner_id text := '22222222-2222-2222-2222-222222222222';
  tech_id    text := '33333333-3333-3333-3333-333333333333';
  n bigint;
begin

  -- =========================================================================
  raise notice '';
  raise notice '-- the anon key --';
  raise notice '';

  -- The whole point of the migration. Before it, each of these returned
  -- rows to anyone who opened devtools on the public website.
  perform chk('THE POINT: anon cannot read leads',
    visible('anon', null, 'leads') = 0,
    format('saw %s', visible('anon', null, 'leads')));
  perform chk('THE POINT: anon cannot read customers',
    visible('anon', null, 'customers') = 0);
  perform chk('THE POINT: anon cannot read jobs',
    visible('anon', null, 'jobs') = 0);
  perform chk('anon cannot read profiles',
    visible('anon', null, 'profiles') = 0);
  perform chk('anon cannot read job assignments',
    visible('anon', null, 'job_assignments') = 0);

  -- ...but the website still has to be able to hand us a lead.
  perform chk('THE POINT: anon CAN still insert a lead — the website depends on it',
    not blocked('anon', null,
      $q$insert into public.leads (name, phone, status, source)
         values ('From the website', '5415550000', 'new', 'website')$q$),
    'without this, every website quote form silently stops reaching the CRM');

  perform chk('and the inserted lead is still invisible to anon afterwards',
    visible('anon', null, 'leads') = 0);

  perform chk('anon cannot update a lead it inserted',
    blocked('anon', null, $q$update public.leads set name = 'x'$q$));
  perform chk('anon cannot delete anything',
    blocked('anon', null, $q$delete from public.leads$q$));
  perform chk('anon cannot insert a customer',
    blocked('anon', null, $q$insert into public.customers (name) values ('x')$q$));
  perform chk('anon cannot insert a job',
    blocked('anon', null, $q$insert into public.jobs (status) values ('scheduled')$q$));

  -- =========================================================================
  raise notice '';
  raise notice '-- a signed-in rep sees what they saw yesterday --';
  raise notice '';

  perform chk('a tech reads every lead', visible('authenticated', tech_id, 'leads') >= 1);
  perform chk('a tech reads every customer', visible('authenticated', tech_id, 'customers') = 1);
  perform chk('a tech reads every job', visible('authenticated', tech_id, 'jobs') = 1);
  perform chk('a partner reads leads too', visible('authenticated', partner_id, 'leads') >= 1);
  perform chk('everyone can read profiles — the history embeds actor names',
    visible('authenticated', tech_id, 'profiles') = 3);

  perform chk('a tech can create a lead',
    not blocked('authenticated', tech_id,
      $q$insert into public.leads (name, status) values ('Knocked a door', 'contacted')$q$));
  perform chk('a tech can update a job',
    not blocked('authenticated', tech_id,
      $q$update public.jobs set status = 'completed'$q$));

  -- Asked for explicitly: a rep records what was actually collected.
  perform chk('THE POINT: a rep can still write the money they collected',
    not blocked('authenticated', tech_id,
      $q$update public.jobs set final_price = 300$q$));

  perform chk('a tech can assign somebody to a job',
    not blocked('authenticated', tech_id,
      $q$insert into public.job_assignments (job_id, tech_id)
         values ('cccccccc-0000-0000-0000-000000000001',
                 '22222222-2222-2222-2222-222222222222')$q$));
  perform chk('and unassign them again — that is scheduling, not destruction',
    not blocked('authenticated', tech_id,
      $q$delete from public.job_assignments
          where tech_id = '33333333-3333-3333-3333-333333333333'$q$));

  -- =========================================================================
  raise notice '';
  raise notice '-- deleting is owners only --';
  raise notice '';

  perform chk('THE POINT: a tech cannot delete a lead',
    blocked('authenticated', tech_id, $q$delete from public.leads$q$));
  perform chk('THE POINT: a tech cannot delete a job',
    blocked('authenticated', tech_id, $q$delete from public.jobs$q$));
  perform chk('THE POINT: a tech cannot delete a customer',
    blocked('authenticated', tech_id, $q$delete from public.customers$q$));
  perform chk('nor can a partner',
    blocked('authenticated', partner_id, $q$delete from public.leads$q$));

  perform chk('an owner can delete a lead',
    not blocked('authenticated', admin_id,
      $q$delete from public.leads where status = 'quoted'$q$));

  -- =========================================================================
  raise notice '';
  raise notice '-- a rep cannot promote themselves or raise their own rate --';
  raise notice '';

  perform chk('THE POINT: a rep cannot make themselves an owner',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set role = 'admin' where id = '%s'$q$, partner_id)),
    'this is the one that turns a rep into an owner with one API call');

  perform chk('THE POINT: a rep cannot raise their own commission rate',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set commission_find_rate = 90 where id = '%s'$q$, partner_id)));

  -- `false`, not `true`. Trenton is already eligible, and the guard compares
  -- old to new — so setting it to the value it already holds changes nothing
  -- and is correctly allowed through. Asserting on a no-op tested nothing.
  perform chk('nor their eligibility flag',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set commission_eligible = false where id = '%s'$q$, partner_id)));

  perform chk('nor the source their rate is restricted to',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set commission_find_source = 'door' where id = '%s'$q$, partner_id)));

  perform chk('nor somebody else''s role',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set role = 'tech' where id = '%s'$q$, tech_id)));

  -- The permission has to stay narrow, not become "reps may not touch their
  -- profile at all" — that would be easy to write by accident and would look
  -- identical until somebody tried to fix the spelling of their own name.
  perform chk('but a rep CAN still edit their own name',
    not blocked('authenticated', partner_id,
      format($q$update public.profiles set full_name = 'Trenton M' where id = '%s'$q$, partner_id)));

  perform chk('a rep cannot edit somebody else''s name either',
    blocked('authenticated', partner_id,
      format($q$update public.profiles set full_name = 'nope' where id = '%s'$q$, tech_id)));

  perform chk('an owner CAN set a rep''s rate',
    not blocked('authenticated', admin_id,
      format($q$update public.profiles set commission_find_rate = 18 where id = '%s'$q$, partner_id)));

  perform chk('an owner CAN change a role',
    not blocked('authenticated', admin_id,
      format($q$update public.profiles set role = 'tech' where id = '%s'$q$, partner_id)));

  -- =========================================================================
  raise notice '';
  raise notice '-- the things that must not have broken --';
  raise notice '';

  -- Netlify functions hold the service key, which bypasses RLS. Here that is
  -- the table owner, which bypasses it the same way. If this ever fails,
  -- every quote, receipt, text and Square call is broken.
  select count(*) into n from public.customers;
  perform chk('THE POINT: the server (service key) still reads everything', n = 1);

  perform chk('a user with no profile row is treated as a rep, not locked out',
    visible('authenticated', '99999999-9999-9999-9999-999999999999', 'leads') >= 1,
    'a dropped profile fetch must not empty the CRM');

  perform chk('...and is certainly not an owner',
    blocked('authenticated', '99999999-9999-9999-9999-999999999999',
      $q$delete from public.leads$q$));

  -- =========================================================================
  raise notice '';
  raise notice '-- views, the window beside the locked door --';
  raise notice '';

  -- A view has no policies of its own and by default runs as its owner, who
  -- bypasses RLS. Locking `leads` while leaving lead_status_age readable by
  -- anon would hand out every lead it selects. Only meaningful once
  -- verify/rls-legacy.sql has created the view; skipped otherwise.
  if to_regclass('public.lead_status_age') is not null then
    perform chk('THE POINT: anon cannot read leads through a view either',
      visible('anon', null, 'lead_status_age') = 0,
      format('saw %s rows through lead_status_age',
             visible('anon', null, 'lead_status_age')));

    perform chk('but a signed-in user still can — the Leads board needs it',
      visible('authenticated', tech_id, 'lead_status_age') >= 1);

    -- A STRUCTURAL check, and flagged as one because it is weaker than the
    -- rest of this file: it inspects a setting rather than trying to get
    -- past it.
    --
    -- Removing security_invoker breaks nothing today — every signed-in user
    -- may read every lead in pass 1, so a view running as its owner returns
    -- the same rows either way, and no behavioural assertion can tell the
    -- difference. It starts mattering the moment pass 2 narrows what a rep
    -- can read, at which point a view without it becomes the way around
    -- every policy written. Mutation testing found exactly this: dropping
    -- the line changed no observable behaviour.
    --
    -- So it is pinned here now, while the reason is fresh, rather than
    -- discovered missing later.
    if current_setting('server_version_num')::int >= 150000 then
      perform chk('and the view is set to run as the caller (load-bearing in pass 2)',
        (select 'security_invoker=true' = any (coalesce(c.reloptions, array[]::text[]))
           from pg_class c
          where c.relname = 'lead_status_age' and c.relkind = 'v'),
        'without it, a view is a way to read rows the policies refuse');
    end if;
  end if;

  raise notice '';
end;
$$;

-- sb_role() / sb_is_admin() answering correctly per caller, outside the
-- transaction-local role juggling above.
do $$
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);
  perform chk('sb_is_admin() is true for an owner', public.sb_is_admin());
  perform chk('sb_role() returns admin', public.sb_role() = 'admin');

  perform set_config('test.uid', '33333333-3333-3333-3333-333333333333', true);
  perform chk('sb_is_admin() is false for a tech', not public.sb_is_admin());

  perform set_config('test.uid', '', true);
  perform chk('sb_is_admin() is false with no session', not public.sb_is_admin());
  perform chk('sb_role() is null with no session', public.sb_role() is null);

  raise notice '';
  raise notice 'all ok - RLS phase 1 holds';
  raise notice '';
end;
$$;
