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

-- Assertions for db/orphan-calls.sql.
--
-- Run order: verify/sms-fixture.sql, verify/call-fixture.sql, db/sms.sql,
-- db/sms-delivery.sql, db/email-delivery.sql, db/delivery-controls.sql,
-- db/contact-history.sql, db/sms-app-messages.sql, db/sms-thread.sql,
-- db/call-tracking.sql, db/orphan-calls.sql, then this.
--
-- WHAT THIS FILE IS ABOUT
-- -----------------------
-- You ring somebody, then enter them as a lead. The call has to be on their
-- page. Three things have to hold for that, and each one fails silently:
--
--   1. the call is WRITTEN, even though nobody owned the number yet
--   2. the timeline FINDS it afterwards, across the two ways a US number
--      can be spelled
--   3. the sweep does not DELETE it once it has been found
--
-- (2) is the one that would have shipped broken: both sides were compared
-- as raw digits, the webhook sends +1 and people type without it, and the
-- result is a row that exists, is correct, and never appears anywhere.
--
-- (3) is the one that would have destroyed data: a sweep whose idea of
-- "unclaimed" disagrees with the timeline's idea of "matched" deletes rows
-- that are on screen.
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
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 1. a call to a number nobody owns --'
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  id1 bigint;
begin
  perform pg_temp.reset();

  id1 := public.record_quo_call('o1', '+15035551111', 'outgoing', 'answered', 95, now());

  perform pg_temp.chk('THE POINT: the call is written, not dropped',
    id1 is not null,
    'this is the whole feature — record_quo_call used to return null here');

  select * into r from public.contact_log where provider_call_id = 'o1';

  perform pg_temp.chk('...against the phone and nothing else',
    r.lead_id is null and r.customer_id is null and r.phone_norm is not null,
    'a row with ids would mean it found somebody; a row with neither ids nor '
    'a phone can never find its way home');

  perform pg_temp.chk('...with the kind and duration a matched call would get',
    r.kind = 'call' and r.duration_seconds = 95 and r.detail = '1m 35s',
    'kind=' || coalesce(r.kind, 'null') || ' detail=' || coalesce(r.detail, 'null'));

  perform pg_temp.chk('...and the direction',
    r.direction = 'out' and r.outcome = 'answered');

  -- The gate from db/call-tracking.sql has to still apply on this path. An
  -- orphan row is cheaper to write than a matched one, which makes it
  -- exactly the place somebody would forget to check whether the call
  -- happened at all.
  perform pg_temp.chk('THE POINT: a call that never happened is still not written',
    public.record_quo_call('o2', '+15035552222', 'outgoing', 'failed', null, now()) is null
    and public.record_quo_call('o3', '+15035552222', 'outgoing', 'abandoned', null, now()) is null
    and (select count(*) from public.contact_log where phone_norm like '%5552222') = 0,
    'failed is the network refusing it and abandoned is hanging up before it '
    'rang — neither is a call anybody made');

  perform pg_temp.chk('a call with no id is still refused',
    public.record_quo_call('', '+15035553333', 'outgoing', 'answered', 60, now()) is null,
    'no id means no dedupe, and Quo retries');

  -- Dedupe matters MORE here than on the matched path. A matched row at
  -- least inflates a counter somebody might notice; a duplicated orphan is
  -- invisible until the day it appears on a lead's page three times.
  --
  -- ONE MUTANT SURVIVES THIS AND IT IS RECORDED RATHER THAN HIDDEN. Deleting
  -- the `on conflict ... do nothing` clause from the orphan insert does not
  -- fail this check, because provider_call_id is uniquely indexed: the
  -- second insert raises, record_quo_call's exception handler swallows it,
  -- and the function returns null exactly as the conflict clause would have
  -- made it. One row either way, and no SQL assertion can tell the two
  -- apart.
  --
  -- The clause stays regardless. Leaning on an exception handler to absorb a
  -- unique violation works only while the insert is the last thing the
  -- function does — plpgsql rolls back to the start of the block, so the day
  -- somebody adds a statement after it, a routine Quo retry starts undoing
  -- that statement too. Writing down what the handler is covering is worth
  -- more than a green number.
  perform public.record_quo_call('o1', '+15035551111', 'outgoing', 'answered', 95, now());
  perform public.record_quo_call('o1', '+15035551111', 'outgoing', 'answered', 95, now());
  perform pg_temp.chk('THE POINT: Quo''s retries are one row, not three',
    (select count(*) from public.contact_log where provider_call_id = 'o1') = 1);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 2. the lead turns up afterwards --'
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
  k text;
begin
  perform pg_temp.reset();

  -- Rung from the Quo app on Tuesday. Nobody in the CRM.
  perform public.record_quo_call('p1', '+15415559876', 'outgoing', 'answered', 120, now() - interval '2 days');

  perform pg_temp.chk('before the lead exists, nobody can see it',
    (select count(*) from public.contact_timeline(null, null)) = 0);

  -- Entered on Thursday, typed the way a person types a number.
  insert into public.leads (id, name, phone, status)
  values ('a1000000-0000-0000-0000-000000000001', 'Valerie Krauss', '(541) 555-9876', 'new');

  select count(*) into n
  from public.contact_timeline('a1000000-0000-0000-0000-000000000001', null)
  where kind = 'call';

  perform pg_temp.chk(
    'THE POINT: the call is on her timeline the moment she exists',
    n = 1,
    'the webhook stored 15415559876 and her phone keys to 5415559876 — if '
    'these are compared as raw digits this is 0, with no error anywhere. '
    'This is the check that would have caught the whole feature doing nothing.');

  -- And the other way round: typed WITH a country code, called without one.
  insert into public.leads (id, name, phone, status)
  values ('a1000000-0000-0000-0000-000000000002', 'Dale Who', '+1 503 555 4321', 'new');
  perform public.record_quo_call('p2', '5035554321', 'incoming', 'answered', 30, now());

  select count(*) into n
  from public.contact_timeline('a1000000-0000-0000-0000-000000000002', null)
  where kind in ('call', 'call_in');

  perform pg_temp.chk('...and the same in reverse, country code on the record',
    n = 1,
    'the two spellings are symmetrical or the fix only works one way round');

  -- A DIFFERENT NUMBER MUST NOT MATCH. The widened comparison is the kind
  -- that is easy to widen too far — a key built from the last 10 digits of
  -- anything would make every 10-digit string match every other.
  perform public.record_quo_call('p3', '+15415559877', 'outgoing', 'answered', 60, now());
  select count(*) into n
  from public.contact_timeline('a1000000-0000-0000-0000-000000000001', null)
  where kind = 'call';
  perform pg_temp.chk('THE POINT: a number one digit different does not match',
    n = 1,
    'still 1, not 2 — comparing keys must not become comparing loosely');

  -- The counters are NOT retrospectively fixed, and that is deliberate and
  -- recorded here so nobody "fixes" it in the database later: the call bar
  -- counts the timeline instead. See outreachFrom() in contactFilters.js.
  select k from (select null::text) t into k;  -- no-op, keeps the block shape
  perform pg_temp.chk('the lead''s contact_attempts column stays at zero',
    (select coalesce(contact_attempts, 0) from public.leads
      where id = 'a1000000-0000-0000-0000-000000000001') = 0,
    'nothing bumped it, because there was no lead when the call happened — '
    'the UI derives outreach from the timeline rather than this column');
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 3. what counts as an orphan --'
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('q1', '+15035551111', 'outgoing', 'answered', 60, now());
  perform public.record_quo_call('q2', '+15035552222', 'outgoing', 'answered', 60, now());

  perform pg_temp.chk('both unmatched calls are orphans',
    (select count(*) from public.orphan_calls) = 2);

  -- One of them becomes a customer.
  insert into public.customers (id, name, phone)
  values ('c1000000-0000-0000-0000-000000000001', 'Someone', '503-555-1111');

  perform pg_temp.chk(
    'THE POINT: a call whose number now belongs to somebody is NOT an orphan',
    (select count(*) from public.orphan_calls) = 1
    and not exists (select 1 from public.orphan_calls where phone_norm like '%5551111'),
    'it is on that customer''s page right now — calling it an orphan is how '
    'the sweep comes to delete visible history');

  -- A text written against nobody belongs to db/sms-app-messages.sql's
  -- rules, not this file's. Widening the view to "any row with no ids"
  -- would make this sweep delete rows it never wrote.
  insert into public.contact_log (lead_id, customer_id, phone_norm, kind, detail)
  values (null, null, '5035558888', 'text', 'an orphan text');

  perform pg_temp.chk('THE POINT: an orphan TEXT is not this file''s business',
    not exists (select 1 from public.orphan_calls where kind = 'text'),
    'sweeping rows another migration wrote, under rules it never agreed to');

  -- A row with no phone at all cannot be reunited with anybody, but it is
  -- also not something this file created, so it stays out of the view.
  insert into public.contact_log (lead_id, customer_id, phone_norm, kind, detail)
  values (null, null, null, 'call', 'a call from nowhere');
  perform pg_temp.chk('a row with no phone is not swept either',
    (select count(*) from public.orphan_calls) = 1);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 4. the sweep --'
-- ---------------------------------------------------------------------------

do $$
declare
  gone int;
begin
  perform pg_temp.reset();

  -- Three calls to strangers: last week, 89 days ago, 91 days ago.
  perform public.record_quo_call('s1', '+15035551111', 'outgoing', 'answered', 60, now() - interval '7 days');
  perform public.record_quo_call('s2', '+15035552222', 'outgoing', 'answered', 60, now() - interval '89 days');
  perform public.record_quo_call('s3', '+15035553333', 'outgoing', 'answered', 60, now() - interval '91 days');

  gone := public.sb_sweep_orphan_calls();

  perform pg_temp.chk('THE POINT: only the one past 90 days goes',
    gone = 1
    and (select count(*) from public.contact_log where provider_call_id = 's3') = 0
    and (select count(*) from public.contact_log where provider_call_id in ('s1', 's2')) = 2,
    'swept ' || gone || ' — 89 days is inside the window and must survive');

  perform pg_temp.chk('a second sweep finds nothing left to do',
    public.sb_sweep_orphan_calls() = 0);

  -- THE ONE THAT DESTROYS DATA. An old call to somebody who has since been
  -- entered is on their page; the sweep must leave it exactly where it is.
  perform public.record_quo_call('s4', '+15415559876', 'outgoing', 'answered', 60, now() - interval '200 days');
  insert into public.leads (id, name, phone, status)
  values ('a1000000-0000-0000-0000-000000000009', 'Valerie Krauss', '(541) 555-9876', 'new');

  gone := public.sb_sweep_orphan_calls();

  perform pg_temp.chk(
    'THE POINT: a 200-day-old call is kept once its number became a lead',
    gone = 0
    and (select count(*) from public.contact_log where provider_call_id = 's4') = 1,
    'swept ' || gone || ' — this row is visible on her page, and age is not '
    'a reason to delete something somebody can see');

  perform pg_temp.chk('...and it really is visible on her page',
    (select count(*) from public.contact_timeline('a1000000-0000-0000-0000-000000000009', null)
      where kind = 'call') = 1,
    'asserted separately from the sweep: "kept" and "visible" are two facts '
    'and a bug in the key comparison would make this one false while the '
    'sweep check still passed');

  -- THE FLOOR. A cron with an unset variable, or a caller who thinks 0 means
  -- "the default", would otherwise delete this morning's calls.
  perform public.record_quo_call('s5', '+15035557777', 'outgoing', 'answered', 60, now());
  perform pg_temp.chk('THE POINT: sweeping 0 days does not wipe the table',
    public.sb_sweep_orphan_calls(0) = 0
    and public.sb_sweep_orphan_calls(-5) = 0
    and public.sb_sweep_orphan_calls(null) = 0
    and (select count(*) from public.contact_log where provider_call_id = 's5') = 1,
    'a nonsense window falls back to 90 days rather than meaning "everything"');

  -- A matched call must be untouchable by the sweep whatever its age. This
  -- is the same guarantee as the 200-day check above, approached from the
  -- other side: there the number became a lead, here it always was one.
  insert into public.leads (id, name, phone, status)
  values ('a1000000-0000-0000-0000-000000000010', 'Old Friend', '503-555-6666', 'contacted');
  perform public.record_quo_call('s6', '+15035556666', 'outgoing', 'answered', 60, now() - interval '400 days');
  perform pg_temp.chk('a call that was matched when it happened is never swept',
    public.sb_sweep_orphan_calls() = 0
    and (select count(*) from public.contact_log where provider_call_id = 's6') = 1);
end $$;


-- ---------------------------------------------------------------------------
\echo '-- 5. the copied function has not drifted --'
-- ---------------------------------------------------------------------------
--
-- db/orphan-calls.sql restates contact_timeline() in full, because `create
-- or replace function` cannot patch one line. A restated function is a bug
-- fix that silently un-applies itself: somebody edits the original, runs the
-- migrations in order, and this file's older copy lands last and wins.
--
-- So the two copies are diffed here, and the ONLY line allowed to differ is
-- the phone comparison. Same guard, and the same reasoning, as the address
-- ladder drift check in verify/job-address.mjs.

do $$
declare
  live text;
begin
  select pg_get_functiondef(p.oid) into live
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'contact_timeline';

  perform pg_temp.chk('THE POINT: the installed timeline compares phone KEYS',
    live like '%sb_phone_key(cl.phone_norm)%',
    'db/contact-history.sql ran after db/orphan-calls.sql and put the raw '
    'equality back — every orphan call is now invisible, with no error');

  perform pg_temp.chk('...and nothing is left comparing raw digits',
    live not like '%cl.phone_norm = ident.phone%',
    'both predicates present means the restatement was edited by hand and '
    'half-applied');

  -- The three sources are all still there. A restated function is also a
  -- chance to lose a whole UNION branch, and the symptom would be a
  -- timeline that looks fine until somebody notices their jobs are missing.
  perform pg_temp.chk('all three sources survived the restatement',
    live like '%public.contact_log%'
    and live like '%public.lead_events%'
    and live like '%public.job_events%');

  perform pg_temp.chk('...and so did the ordering that keeps events in order',
    live like '%order by 1, 14%',
    'triggers write several rows sharing now() to the microsecond; without '
    'the seq tiebreak "payment" sorts above "completed"');

  perform pg_temp.chk('...and the exclusion that stops calls showing twice',
    live like '%<> ''call''%',
    'lead_events still holds the pre-contact_log calls; dropping this line '
    'shows every historic call twice');
end $$;

-- record_quo_call is restated too, and db/call-outcome.sql owns the other
-- copy. Whichever of the two files runs LAST wins, and the symptom of
-- losing this one is the feature doing nothing with no error — the same
-- silence as the timeline check above.

do $$
declare
  live text;
  n    int;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'record_quo_call';

  perform pg_temp.chk('THE POINT: there is exactly ONE record_quo_call',
    n = 1,
    'found ' || n || ' — this file adding an argument instead of replacing '
    'the function leaves two overloads, and which one a six-argument call '
    'reaches is not something anybody should have to work out');

  select pg_get_functiondef(p.oid) into live
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'record_quo_call';

  perform pg_temp.chk('THE POINT: the installed one still writes orphan rows',
    live like '%insert into public.contact_log%',
    'db/call-outcome.sql ran after db/orphan-calls.sql and put its own copy '
    'back — strangers are dropped again and nothing says so');

  -- The four things call-outcome.sql added, which this file's copy has to
  -- carry. Losing any of them is a silent revert of somebody else's work.
  perform pg_temp.chk('...and still has call-outcome.sql''s inverted gate',
    live like '%not_a_call%' and live like '%ai-handled%',
    'the status-word allowlist it replaced dropped every call Quo reported '
    'with a word nobody had thought of');

  perform pg_temp.chk('...and its wording function',
    live like '%sb_call_phrase%');

  perform pg_temp.chk('...and the three-argument connected test',
    live like '%sb_call_connected(p_status, p_duration, p_answered)%');

  perform pg_temp.chk('...and keeps an abandoned INBOUND call',
    live like '%abandoned%' and live like '%and not inbound%',
    'a caller who gave up waiting is a lead who tried to reach you');
end $$;

\echo ''
\echo 'all ok — rung before they were entered, and still there afterwards'
