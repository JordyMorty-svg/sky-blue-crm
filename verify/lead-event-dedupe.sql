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
      'runs against a scratch database built by verify/sms-fixture.sql and '
      'verify/call-fixture.sql.';
  end if;
end $$;

-- Assertions for db/lead-event-dedupe.sql.
--
-- Run order: the call-tracking chain, db/call-notes.sql, db/call-outcome.sql,
-- db/lead-event-dedupe.sql, then this.
--
-- WHAT THIS FILE IS ABOUT
-- -----------------------
-- A call that advances a lead was writing the move twice: once on its own
-- contact_log row ("Called · New → Contacted") and once as a bare
-- lead_events row ("New → Contacted"), a second apart on the same timeline.
--
-- The fix is a transaction-local flag. Flags are the right tool here and
-- also the dangerous one, because the failure mode is NOT a duplicate row —
-- it is a MISSING one. A flag that leaks past its update, or that is read
-- too widely, deletes real history and leaves nothing behind to notice. So
-- most of this file is about status changes that must STILL be logged.
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
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.job_events;
  delete from public.jobs;
  delete from public.customers;
  delete from public.leads;
  -- The flag must not survive between cases, or a later check would pass
  -- for the wrong reason.
  perform set_config('sb.skip_lead_event', 'off', true);
end $$;

-- One lead on 'new', every time.
create or replace function pg_temp.a_lead(p_phone text default '541-555-0101')
returns uuid language plpgsql as $$
declare id uuid := gen_random_uuid();
begin
  insert into public.leads (id, name, phone, status)
  values (id, 'Kristina', p_phone, 'new');
  return id;
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 1. a call that advances a lead writes the move ONCE --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n_evt   int;
  n_log   int;
  r       record;
begin
  perform pg_temp.reset();
  lid := pg_temp.a_lead();

  -- Created-as is written by the INSERT above and is not a transition.
  perform pg_temp.chk('the lead starts with exactly one event, its creation',
    (select count(*) from public.lead_events where lead_id = lid) = 1);

  perform public.record_quo_call('d1', '+15415550101', 'outgoing', 'answered', 90, now(), true);

  select count(*) into n_evt
  from public.lead_events le
  where le.lead_id = lid and le.from_status is not null;

  select count(*) into n_log
  from public.contact_log cl
  where cl.lead_id = lid and cl.to_status is not null;

  perform pg_temp.chk('THE POINT: the move is on the call row',
    n_log = 1,
    'this is what renders as "Called · New → Contacted"');

  perform pg_temp.chk('THE POINT: and NOT also as a bare status event',
    n_evt = 0,
    'found ' || n_evt || ' — this is the duplicate: the same move, a second '
    'apart, once as outreach and once as a status change');

  perform pg_temp.chk('...and the lead really did move',
    (select status from public.leads where id = lid) = 'contacted',
    'suppressing the LOG must not suppress the CHANGE');

  select * into r from public.contact_log where provider_call_id = 'd1';
  perform pg_temp.chk('...and the call row carries both ends of it',
    r.from_status = 'new' and r.to_status = 'contacted');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 2. everything that must STILL be logged --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n       int;
begin
  perform pg_temp.reset();
  lid := pg_temp.a_lead();

  -- THE WORST FAILURE AVAILABLE. A flag left on, or read on INSERT, gives a
  -- lead with no beginning — and an empty history looks like a quiet lead,
  -- not like a bug.
  perform set_config('sb.skip_lead_event', 'on', true);
  declare id2 uuid := gen_random_uuid();
  begin
    insert into public.leads (id, name, phone, status)
    values (id2, 'Second', '541-555-0202', 'new');
    perform pg_temp.chk('THE POINT: "Added as a lead" is written even with the flag on',
      exists (select 1 from public.lead_events where lead_id = id2 and from_status is null),
      'nothing else writes the first row of a timeline');
  end;
  perform set_config('sb.skip_lead_event', 'off', true);

  -- An ordinary hand-made change.
  update public.leads set status = 'quoted' where id = lid;
  select count(*) into n from public.lead_events
   where lead_id = lid and from_status = 'new' and to_status = 'quoted';
  perform pg_temp.chk('a status changed by hand is logged',
    n = 1);

  -- THE LEAK. record_contact_as sets the flag and must clear it before
  -- anything else happens on the same connection. Supabase pools, so the
  -- next statement is routinely somebody else's.
  perform pg_temp.reset();
  lid := pg_temp.a_lead();
  perform public.record_quo_call('d2', '+15415550101', 'outgoing', 'answered', 90, now(), true);
  update public.leads set status = 'booked' where id = lid;

  select count(*) into n from public.lead_events
   where lead_id = lid and from_status = 'contacted' and to_status = 'booked';
  perform pg_temp.chk(
    'THE POINT: the flag does not leak into the next statement',
    n = 1,
    'the call cleared it; a change made straight afterwards is ordinary '
    'history and losing it leaves no trace at all');

  perform pg_temp.chk('...and the flag reads as off afterwards',
    coalesce(current_setting('sb.skip_lead_event', true), 'off') = 'off');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 3. a call that does NOT advance anybody --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n       int;
begin
  perform pg_temp.reset();
  lid := pg_temp.a_lead();

  -- Rang out. The lead stays on New — db/call-tracking.sql's whole point —
  -- so there is no move to record anywhere.
  perform public.record_quo_call('d3', '+15415550101', 'outgoing', 'no-answer', null, now(), false);

  perform pg_temp.chk('a lead that did not move logs no transition',
    (select count(*) from public.lead_events where lead_id = lid and from_status is not null) = 0
    and (select status from public.leads where id = lid) = 'new');

  -- A SECOND CALL TO AN ALREADY-CONTACTED LEAD. No move, so nothing to
  -- suppress and nothing to write.
  update public.leads set status = 'contacted' where id = lid;
  perform public.record_quo_call('d4', '+15415550101', 'outgoing', 'answered', 90, now(), true);

  select count(*) into n from public.lead_events
   where lead_id = lid and from_status = 'contacted';
  perform pg_temp.chk('a call to an already-contacted lead adds no status row',
    n = 0);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 4. refresh_call_detail is NOT suppressed --'
-- ---------------------------------------------------------------------------
--
-- When a transcript finally reports a duration for a call that looked
-- unanswered, refresh_call_detail advances the lead. That move is NOT on
-- any contact_log row — the row was written as an attempt, with no
-- transition — so the lead_events row is the only record there is.

do $$
declare
  lid uuid;
  n_evt   int;
begin
  perform pg_temp.reset();
  lid := pg_temp.a_lead();

  -- Quo's live shape: completed, no duration, nobody knows yet.
  perform public.record_quo_call('d5', '+15415550101', 'outgoing', 'completed', null, now(), null);

  perform pg_temp.chk('an unreported call leaves the lead on New',
    (select status from public.leads where id = lid) = 'new');

  -- The transcript arrives and reports a duration. record_call_summary
  -- carries the words; the DURATION — which is what says a conversation
  -- happened — comes with the transcript.
  perform public.record_call_summary('d5', array['Talked about windows.'], null);
  -- A NON-EMPTY dialogue. record_call_transcript refuses an empty one —
  -- "a transcript of silence" — and returns false without storing the
  -- duration, which is the thing this case is actually about.
  perform public.record_call_transcript(
    'd5',
    '[{"speaker":"Jordan","text":"Morning — about your windows."}]'::jsonb,
    95);
  perform public.refresh_call_detail('d5');

  perform pg_temp.chk('...and the summary moves her',
    (select status from public.leads where id = lid) = 'contacted');

  select count(*) into n_evt from public.lead_events
   where lead_id = lid and from_status = 'new' and to_status = 'contacted';

  perform pg_temp.chk(
    'THE POINT: that move IS logged as a status event',
    n_evt = 1,
    'found ' || n_evt || ' — the contact_log row was written as an attempt '
    'with no transition on it, so suppressing this one loses the move '
    'entirely rather than de-duplicating it');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 5. the duplicates already in the table --'
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  gone    int;
begin
  perform pg_temp.reset();
  lid := pg_temp.a_lead();

  -- Hand-build what the old code produced: a call row carrying the move,
  -- and a bare lead_events row for the same move a second later.
  insert into public.contact_log (lead_id, phone_norm, kind, from_status, to_status, detail, created_at)
  values (lid, '5415550101', 'call', 'new', 'contacted', '1m 30s', now() - interval '1 day');
  insert into public.lead_events (lead_id, from_status, to_status, created_at)
  values (lid, 'new', 'contacted', now() - interval '1 day' + interval '1 second');

  -- And a genuine, unrelated change that must survive.
  insert into public.lead_events (lead_id, from_status, to_status, created_at)
  values (lid, 'contacted', 'quoted', now());

  perform pg_temp.chk('the duplicate is spotted',
    (select count(*) from public.duplicate_status_events) = 1);

  gone := public.sb_purge_duplicate_status_events();

  perform pg_temp.chk('THE POINT: only the duplicate goes',
    gone = 1
    and (select count(*) from public.lead_events
          where lead_id = lid and from_status = 'new') = 0
    and (select count(*) from public.lead_events
          where lead_id = lid and from_status = 'contacted' and to_status = 'quoted') = 1,
    'purged ' || gone || ' — the unrelated move is somebody''s real history');

  perform pg_temp.chk('...and the call row it duplicated is untouched',
    (select count(*) from public.contact_log where lead_id = lid) = 1,
    'the move still has to be visible somewhere');

  -- SAME DESTINATION, DIFFERENT ORIGIN. A lead moved quoted → contacted by
  -- hand, beside a call that moved a different visit new → contacted. The
  -- two share a to_status and nothing else, and matching on the
  -- destination alone would delete the hand-made one.
  insert into public.contact_log (lead_id, phone_norm, kind, from_status, to_status, detail)
  values (lid, '5415550101', 'call', 'new', 'contacted', '2m 0s');
  insert into public.lead_events (lead_id, from_status, to_status)
  values (lid, 'quoted', 'contacted');
  perform pg_temp.chk('THE POINT: a different move to the same status is not a duplicate',
    (select count(*) from public.duplicate_status_events) = 0,
    'both ends of the move have to match — the destination alone is shared '
    'by every route into Contacted');
  delete from public.contact_log where detail = '2m 0s';
  delete from public.lead_events where from_status = 'quoted';

  -- A CREATION EVENT HAS A NULL from_status and must never be matched.
  -- There is no guard for this; `cl.from_status = le.from_status` is NULL
  -- against it rather than true. Asserted rather than assumed, because
  -- that is a property of three-valued logic and not of anything written
  -- down in the view.
  insert into public.contact_log (lead_id, phone_norm, kind, from_status, to_status, detail)
  values (lid, '5415550101', 'call', null, 'new', 'no move');
  perform pg_temp.chk('THE POINT: "Added as a lead" can never be purged',
    not exists (select 1 from public.duplicate_status_events where from_status is null),
    'the first row of a timeline, deleted — and an empty history looks like '
    'a quiet lead rather than a bug');
  delete from public.contact_log where detail = 'no move';

  -- SAME MOVE, DIFFERENT DAY. A lead put back to New and contacted again a
  -- week later is two real events, and the second one must not be eaten
  -- because an old contact_log row happens to carry the same pair.
  insert into public.lead_events (lead_id, from_status, to_status, created_at)
  values (lid, 'new', 'contacted', now());
  perform pg_temp.chk('THE POINT: the same move a week later is not a duplicate',
    (select count(*) from public.duplicate_status_events) = 0,
    'matched on the from/to pair AND a ten-second window — a looser rule '
    'deletes a real status change somebody made');

  perform pg_temp.chk('purging twice is safe',
    public.sb_purge_duplicate_status_events() = 0);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 6. the restated functions have not drifted --'
-- ---------------------------------------------------------------------------
--
-- This file restates two functions that other migrations also define:
-- log_lead_status_change (db/quotes.sql) and record_contact_as
-- (db/call-tracking.sql). Whichever runs last wins.

do $$
declare
  trig text;
  rca  text;
begin
  select pg_get_functiondef(p.oid) into trig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'log_lead_status_change';

  perform pg_temp.chk('THE POINT: the installed trigger reads the quiet flag',
    trig like '%sb.skip_lead_event%',
    'db/quotes.sql or db/lead-events.sql ran last and put its own copy '
    'back — the duplicates return and nothing says so');

  perform pg_temp.chk('...and still reads sb.actor from db/quotes.sql',
    trig like '%sb.actor%',
    'copying db/lead-events.sql''s older body instead would drop the actor '
    'on every quote accepted from a public link');

  perform pg_temp.chk('...and still guards against a non-transition',
    trig like '%is distinct from old.status%',
    'without it every save of the lead form writes a status event');

  select pg_get_functiondef(p.oid) into rca
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_contact_as';

  perform pg_temp.chk('THE POINT: record_contact_as sets the flag',
    rca like '%set_config(''sb.skip_lead_event'', ''on'', true)%',
    'db/call-tracking.sql ran last and put its own copy back');

  perform pg_temp.chk('...and clears it in the same breath',
    rca like '%set_config(''sb.skip_lead_event'', ''off'', true)%',
    'left on, it suppresses whatever the next statement on this pooled '
    'connection does — and a missing status event leaves no trace');

  perform pg_temp.chk('...transaction-locally, not for the session',
    rca not like '%skip_lead_event'', ''on'', false%',
    'the third argument false makes it outlive the transaction, which on a '
    'pooled connection means it outlives this request');

  -- The parts of record_contact_as this file had to carry across.
  perform pg_temp.chk('...and still bumps the counters',
    rca like '%contact_attempts%' and rca like '%last_contacted_at%');

  perform pg_temp.chk('...and still only advances a lead that was REACHED',
    rca like '%and reached then ''contacted''%',
    'ringing out three times must leave a lead on New — the whole point of '
    'db/call-tracking.sql');

  perform pg_temp.chk('...and still does not count an inbound call as outreach',
    rca like '%outbound%');
end $$;

\echo ''
\echo 'all ok — one move, one row'
