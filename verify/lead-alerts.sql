\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE WRITES AND DELETES ROWS. Throwaway Postgres only, never      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it writes rows. It only '
      'runs against a scratch database built by verify/sms-fixture.sql.';
  end if;
end $$;

-- Assertions for db/lead-alerts.sql.
--
-- Run order: verify/sms-fixture.sql, db/sms.sql, db/lead-ack.sql,
-- db/lead-alerts.sql, then this.
--
-- WHAT THIS FILE IS ABOUT
-- -----------------------
-- A lead came in on 12 October and nobody was told for two hours. The CRM
-- now texts Jordan and Hayden from the sweep that already runs every minute.
--
-- Three ways that can go wrong, in descending order of how bad:
--
--   1. IT TEXTS THE WHOLE BACK CATALOGUE. The first run after deploying sees
--      a table of leads with no alert rows and starts working through it.
--      Forty texts at two in the morning about enquiries from August is
--      worse than the problem being fixed.
--   2. IT TEXTS TWICE. Two sweeps overlap, or a crash re-runs one. A
--      duplicate alert is how somebody learns to ignore the first.
--   3. IT TEXTS NOBODY. Which is where we started.
--
-- (1) is guarded twice over, by the backfill AND the stale window, and
-- neither is load-bearing alone. That is on purpose and it is checked here
-- the same way — each guard is tested with the other one removed.
--
-- Checks marked THE POINT are the ones this file exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

create or replace function pg_temp.reset()
returns void language plpgsql as $$
begin
  delete from public.lead_alerts;
  delete from public.leads;
end $$;

-- A lead as the website inserts one: no created_by, because the row goes in
-- under the anon key.
create or replace function pg_temp.web_lead(
  p_when timestamptz default now(),
  p_name text default 'Kristina'
)
returns uuid language plpgsql as $$
declare id uuid := gen_random_uuid();
begin
  insert into public.leads (id, name, phone, email, address, service, source, created_at)
  values (id, p_name, '541-555-0101', 'k@example.com', '123 NW 9th St, Corvallis',
          'windows', 'website', p_when);
  return id;
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 1. a new lead is claimed exactly once --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid  uuid;
  r    record;
  n    int;
begin
  perform pg_temp.reset();
  lid := pg_temp.web_lead();

  select * into r from public.sb_claim_lead_alerts(10);

  perform pg_temp.chk('THE POINT: the lead comes back to be alerted',
    r.out_lead_id = lid,
    'this is the whole feature — before it, nothing told anybody');

  perform pg_temp.chk('...with what a text needs on it',
    r.out_name = 'Kristina'
      and r.out_phone = '541-555-0101'
      and r.out_service = 'windows'
      and r.out_source = 'website'
      and r.out_address like '123 NW 9th%',
    'name=' || coalesce(r.out_name, 'null') || ' phone=' || coalesce(r.out_phone, 'null'));

  select count(*) into n from public.sb_claim_lead_alerts(10);
  perform pg_temp.chk('THE POINT: a second call claims nothing',
    n = 0,
    'the insert into lead_alerts IS the claim. Without it two overlapping '
    'sweeps both send, and a duplicate alert is how somebody learns to '
    'ignore the first one');

  perform pg_temp.chk('...and the claim is recorded',
    exists (select 1 from public.lead_alerts where lead_id = lid));

  -- ONE MUTANT SURVIVES THIS FILE AND IT IS RECORDED RATHER THAN HIDDEN.
  --
  -- Deleting `on conflict (lead_id) do nothing` from the claim does not fail
  -- anything here, because the `not exists` filter above it means a single
  -- session never produces a conflict. The two guards only disagree under
  -- CONCURRENCY, which one psql connection cannot create: two sweeps in
  -- READ COMMITTED both evaluate `picked`, both see the lead as unclaimed,
  -- and both try to insert. With the clause the loser gets nothing back and
  -- sends nothing; without it the loser raises a unique violation and
  -- abandons its whole batch.
  --
  -- The clause stays. A test harness that cannot reproduce a race is not an
  -- argument that the race does not happen — Netlify runs this on a
  -- one-minute schedule and a slow run overlapping the next is the ordinary
  -- case, not the exotic one.
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 2. what must NEVER be claimed --'
-- ---------------------------------------------------------------------------

do $$
declare
  n     int;
  typed uuid := gen_random_uuid();
  who   uuid := gen_random_uuid();
begin
  perform pg_temp.reset();

  -- A LEAD SOMEBODY TYPED IN. created_by is set when a signed-in person
  -- added it, which means they were standing there talking to the customer.
  insert into public.profiles (id, full_name) values (who, 'Jordan');
  insert into public.leads (id, name, phone, source, created_by)
  values (typed, 'Walk-up', '541-555-0202', 'door', who);

  select count(*) into n from public.sb_claim_lead_alerts(10);
  perform pg_temp.chk('THE POINT: a lead somebody typed in does not text them about it',
    n = 0,
    'found ' || n || ' — Jordan does not need a text about the customer he '
    'is currently talking to, and an alert that is usually noise is an '
    'alert nobody reads');

  -- AN OLD ONE. Both this and the backfill in section 5 of the migration
  -- independently prevent the first-run disaster; this is the one still
  -- standing if a lead is somehow inserted with an old created_at.
  perform pg_temp.reset();
  perform pg_temp.web_lead(now() - interval '7 hours', 'Ancient');
  select count(*) into n from public.sb_claim_lead_alerts(10);
  perform pg_temp.chk('THE POINT: a lead older than the window is never alerted',
    n = 0,
    'a text about a form filled in yesterday is confusing rather than '
    'useful, and on the first run after deploying it is forty of them');

  -- The edge, from the other side. Five hours is inside six.
  perform pg_temp.reset();
  perform pg_temp.web_lead(now() - interval '5 hours', 'Recent enough');
  select count(*) into n from public.sb_claim_lead_alerts(10);
  perform pg_temp.chk('...but one inside the window still is',
    n = 1,
    'the window has to have a far edge, or it is just "off"');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 3. the first run after deploying --'
-- ---------------------------------------------------------------------------
--
-- THE WORST FAILURE AVAILABLE, reproduced properly: a database that already
-- has leads in it, with db/lead-alerts.sql run for the first time.

do $$
begin
  perform pg_temp.reset();

  -- A history. Some of it recent enough that the stale window alone would
  -- not save us.
  perform pg_temp.web_lead(now() - interval '10 days', 'August');
  perform pg_temp.web_lead(now() - interval '2 days', 'Last week');
  perform pg_temp.web_lead(now() - interval '30 minutes', 'This morning');
  perform pg_temp.web_lead(now() - interval '2 minutes', 'Just now');
end $$;

-- THE MIGRATION ITSELF, not a copy of its backfill.
--
-- The first draft of this file pasted the INSERT from section 5 of
-- db/lead-alerts.sql into the block above. It passed, and it would have gone
-- on passing with that section deleted from the migration entirely — the
-- test was backfilling the table and then congratulating the migration for
-- it. Mutation testing is the only reason that was caught, and it is the
-- third time in this repo a verify file has tested its own paste.
--
-- Re-running the whole migration is safe by construction: every statement in
-- it is `create or replace`, `if not exists`, or `on conflict do nothing`.
\i db/lead-alerts.sql

do $$
declare n int;
begin
  select count(*) into n from public.sb_claim_lead_alerts(100);
  perform pg_temp.chk(
    'THE POINT: nothing at all is due on the first sweep after deploying',
    n = 0,
    'found ' || n || ' — including "This morning" and "Just now", which the '
    'stale window would happily have texted. The backfill is what stops '
    'the phone going off about enquiries that were already handled');

  -- And a genuinely new one still works afterwards.
  perform pg_temp.web_lead(now(), 'Arrived after the deploy');
  select count(*) into n from public.sb_claim_lead_alerts(100);
  perform pg_temp.chk('...and the next real lead is still claimed',
    n = 1,
    'a backfill that also stopped future leads would be a feature that '
    'deploys into permanent silence');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 4. the limit, the order, and nothing else --'
-- ---------------------------------------------------------------------------

do $$
declare
  n     int;
  first text;
begin
  perform pg_temp.reset();
  perform pg_temp.web_lead(now() - interval '3 minutes', 'Oldest');
  perform pg_temp.web_lead(now() - interval '2 minutes', 'Middle');
  perform pg_temp.web_lead(now() - interval '1 minute',  'Newest');

  -- ZERO FIRST, WHILE THERE IS STILL WORK TO TAKE. Asked after the other
  -- three had been claimed, this check passed against a function that
  -- ignored the limit entirely — there was nothing left for it to wrongly
  -- claim. Order of assertions is part of the assertion.
  perform pg_temp.chk('a limit of zero claims nothing',
    (select count(*) from public.sb_claim_lead_alerts(0)) = 0
    and (select count(*) from public.lead_alerts) = 0,
    'section 6 of the migration calls it with 0 to COUNT what is due — if '
    'that claimed anything, running the migration would silently consume '
    'the alerts it was reporting on');

  perform pg_temp.chk('...and a negative limit does not mean "all of them"',
    (select count(*) from public.sb_claim_lead_alerts(-5)) = 0
    and (select count(*) from public.lead_alerts) = 0,
    'greatest(p_limit, 0) — `limit -5` is an error in Postgres, not a '
    'no-op, and an error inside the sweep is a sweep that stops');

  select count(*) into n from public.sb_claim_lead_alerts(2);
  perform pg_temp.chk('the limit is honoured',
    n = 2,
    'a sweep that claims everything in one go is a sweep that times out '
    'halfway through a backlog, having claimed all of it');

  -- THE OLDEST TWO, not any two. A lead that has been waiting is the one
  -- most at risk of going elsewhere, so a backlog has to drain in the order
  -- people wrote in.
  perform pg_temp.chk('THE POINT: the two it took were the two oldest',
    exists (select 1 from public.lead_alerts a join public.leads l on l.id = a.lead_id
             where l.name = 'Oldest')
    and exists (select 1 from public.lead_alerts a join public.leads l on l.id = a.lead_id
                 where l.name = 'Middle')
    and not exists (select 1 from public.lead_alerts a join public.leads l on l.id = a.lead_id
                     where l.name = 'Newest'),
    'claimed newest-first, the person who has been waiting longest waits '
    'longer still every time a new lead arrives');

  select out_name into first from public.sb_claim_lead_alerts(1);
  perform pg_temp.chk('...and the one left over comes next',
    first = 'Newest');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 5. sending it again on purpose --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
begin
  perform pg_temp.reset();
  lid := pg_temp.web_lead();

  perform public.sb_claim_lead_alerts(10);
  perform pg_temp.chk('claimed once',
    (select count(*) from public.sb_claim_lead_alerts(10)) = 0);

  perform pg_temp.chk('THE POINT: unclaiming puts it back',
    public.sb_unclaim_lead_alert(lid) = true
    and (select count(*) from public.sb_claim_lead_alerts(10)) = 1,
    'the claim happens before the send, so a text that failed leaves a lead '
    'marked as alerted and nobody told. This is the way back');

  perform pg_temp.chk('unclaiming something that was never claimed says so',
    public.sb_unclaim_lead_alert(gen_random_uuid()) = false);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 6. the claim survives the lead being deleted --'
-- ---------------------------------------------------------------------------

do $$
declare lid uuid;
begin
  perform pg_temp.reset();
  lid := pg_temp.web_lead();
  perform public.sb_claim_lead_alerts(10);

  delete from public.leads where id = lid;

  perform pg_temp.chk('deleting a lead takes its alert row with it',
    not exists (select 1 from public.lead_alerts where lead_id = lid),
    'on delete cascade. Not set null: a claim row pointing at nothing is a '
    'row that can never be matched, cleaned up or reasoned about — unlike '
    'contact_log, where the phone number keeps an orphaned row useful');
end $$;

\echo ''
\echo 'all ok — told once, told quickly, and never about August'
