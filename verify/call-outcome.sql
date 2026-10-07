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

-- Assertions for db/call-outcome.sql.
--
-- Run order: the call-tracking chain, db/call-notes.sql, db/call-outcome.sql,
-- then this.
--
-- WHAT THIS FILE IS ABOUT
-- -----------------------
-- db/call-tracking.sql decided whether a call had happened by matching
-- Quo's `status` against a list of words. The list was a guess, and the word
-- Quo actually sends for a completed call — `completed` — was not on it. So
-- every call placed through Quo was silently discarded, for weeks, with a
-- log line suggesting it might have been a duplicate.
--
-- The evidence this file is written against, read off the live Netlify log
-- and Quo's own API on 6–7 Oct 2026:
--
--   call.completed webhook   status 'completed', duration NULL
--   the same call, via API   status 'completed', duration 17s
--   an unanswered inbound    status 'no-answer', duration 0s
--
-- Two facts to hold on to: `completed` is the ordinary end of a call that
-- ran, and the WEBHOOK DOES NOT CARRY THE DURATION. Everything here follows
-- from those.
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
  delete from public.call_notes;
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;
  delete from public.customers;

  insert into public.leads (id, name, phone, status, contact_attempts)
  values ('d0000000-0000-0000-0000-000000000001', 'Dana Reyes', '(541) 555-0101', 'new', 0);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The status Quo actually sends
-- ---------------------------------------------------------------------------

do $$
declare r record; n bigint;
begin
  perform pg_temp.reset();

  -- THE LIVE PAYLOAD, field for field. If this one check had existed in
  -- August, none of the last two days would have happened.
  n := public.record_quo_call(
         'AC-example-call-id', '+15415550101',
         'outgoing', 'completed', null, now(), true);

  perform pg_temp.chk(
    'THE POINT: a call Quo calls "completed" is written down',
    n is not null,
    'this is the exact payload the live webhook sends, and the old gate '
    'dropped it because "completed" was not in a hand-written list of words');

  select * into r from public.contact_log
   where provider_call_id = 'AC-example-call-id';

  perform pg_temp.chk(
    'THE POINT: an answeredAt with no duration yet still counts as a conversation',
    r.kind = 'call',
    'kind = ' || coalesce(r.kind, 'null') || ' — call.completed arrives before '
    'Quo has computed the duration, so answeredAt is all there is to go on');

  perform pg_temp.chk('...and says so without inventing a length',
    r.detail = 'Answered', coalesce(r.detail, 'null'));

  -- The same call once the duration is known.
  n := public.record_quo_call('c-17', '+15415550101',
         'outgoing', 'completed', 17, now(), true);
  select * into r from public.contact_log where provider_call_id = 'c-17';
  perform pg_temp.chk('a completed call with a duration reads as one',
    r.kind = 'call' and r.detail = '0m 17s',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  -- Quo's own missed-call tooling treats "completed with zero duration and
  -- no answer signal" as a missed call. So does this.
  n := public.record_quo_call('c-zero', '+15415550101',
         'outgoing', 'completed', 0, now(), false);
  select * into r from public.contact_log where provider_call_id = 'c-zero';
  perform pg_temp.chk(
    'THE POINT: "completed" with no answer and no seconds is not a conversation',
    r.kind = 'call_attempt' and r.detail = 'No answer',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  n := public.record_quo_call('c-in', '+15415550101',
         'incoming', 'no-answer', 0, now(), false);
  select * into r from public.contact_log where provider_call_id = 'c-in';
  perform pg_temp.chk('an unanswered inbound call is a missed call',
    r.kind = 'call_missed' and r.detail = 'They rang, we missed it',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 2. The gate is now a deny-list, and that is the fix
-- ---------------------------------------------------------------------------

do $$
declare r record; n bigint;
begin
  perform pg_temp.reset();

  -- THE WHOLE LESSON OF THE LAST TWO DAYS.
  --
  -- An allow-list of statuses means the day Quo adds or renames one, every
  -- call under it disappears without a trace. A deny-list means the worst
  -- case is a row somebody can look at and argue with.
  n := public.record_quo_call('unknown-word', '+15415550101',
         'outgoing', 'quo-renamed-this-in-2027', 30, now(), true);
  perform pg_temp.chk(
    'THE POINT: a status nobody has seen before is still written down',
    n is not null,
    'the old allow-list is exactly how "completed" vanished; a word we do '
    'not know is a row to look at, not silence');

  -- ...but it is not promoted on a duration alone, because an unanswered
  -- call's duration is its RING time.
  perform pg_temp.chk(
    'THE POINT: ...but an unrecognised status with no answeredAt is not a conversation',
    not public.sb_call_connected('quo-renamed-this-in-2027', 300),
    'a phone rings for about twenty-five seconds before voicemail, so a '
    'duration on its own proves nothing');

  perform pg_temp.chk('...while the same status WITH an answeredAt is',
    public.sb_call_connected('quo-renamed-this-in-2027', 300, true),
    'answeredAt is the fact; the status is only a word');

  -- The four that are genuinely not calls.
  perform pg_temp.chk('a failed call is not written down',
    public.record_quo_call('x1', '+15415550101', 'outgoing', 'failed', 0, now()) is null);
  perform pg_temp.chk('nor an unknown one',
    public.record_quo_call('x2', '+15415550101', 'outgoing', 'unknown', 0, now()) is null);
  perform pg_temp.chk('nor one an AI handled',
    public.record_quo_call('x3', '+15415550101', 'incoming', 'ai-handled', 40, now()) is null);

  -- ABANDONED CUTS BOTH WAYS, and the direction decides.
  perform pg_temp.chk(
    'THE POINT: an abandoned OUTGOING call is not written down',
    public.record_quo_call('x4', '+15415550101', 'outgoing', 'abandoned', 0, now()) is null,
    'somebody pressed call and hung up before it rang — that is the '
    'button-press-as-history this whole feature exists to stop');

  n := public.record_quo_call('x5', '+15415550101', 'incoming', 'abandoned', 8, now());
  perform pg_temp.chk(
    'THE POINT: an abandoned INCOMING call IS',
    n is not null,
    'a caller who gave up waiting is a lead that tried to reach you, which '
    'is the most worth knowing of the lot');

  select * into r from public.contact_log where provider_call_id = 'x5';
  perform pg_temp.chk('...as a missed call, not as outreach',
    r.kind = 'call_missed', coalesce(r.kind, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Reclassification, which is what makes a null duration survivable
-- ---------------------------------------------------------------------------
--
-- The webhook does not carry a duration. The transcript does. So a call is
-- written from what call.completed knows and corrected when the rest turns
-- up — otherwise a seventeen-second conversation sits on the timeline as
-- "No answer" forever, with its own transcript underneath it.

do $$
declare r record; st text; ok boolean;
begin
  perform pg_temp.reset();

  -- Nothing known: no duration, no answeredAt. The honest row.
  perform public.record_quo_call('late-1', '+15415550101',
    'outgoing', 'completed', null, now(), null);

  select * into r from public.contact_log where provider_call_id = 'late-1';
  perform pg_temp.chk('an outcome Quo has not reported is not guessed at',
    r.kind = 'call_attempt' and r.detail = 'Outcome not reported yet',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  select status into st from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('...and does not advance the lead on a guess', st = 'new', st);

  -- The transcript arrives with the real length.
  ok := public.record_call_transcript('late-1',
          '[{"at":0,"who":"User","text":"Hello?"}]'::jsonb, 17);

  select * into r from public.contact_log where provider_call_id = 'late-1';
  perform pg_temp.chk(
    'THE POINT: the transcript upgrades the call to what it actually was',
    r.kind = 'call',
    'kind = ' || coalesce(r.kind, 'null') || ' — without this, every call on '
    'this account stays "No answer", because no duration ever arrives in time');

  perform pg_temp.chk('...with the duration now on the row',
    r.duration_seconds = 17, coalesce(r.duration_seconds::text, 'null'));

  perform pg_temp.chk('...and reading as a conversation',
    r.detail = '0m 17s', coalesce(r.detail, 'null'));

  select status into st from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: and the lead finally moves off New',
    st = 'contacted',
    'status = ' || st || ' — the move was deferred, not skipped');
end $$;

-- A short one must NOT be promoted. The upgrade has to be able to say no,
-- or it is just the old click-logging with a slower clock.
do $$
declare r record; st text;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('late-2', '+15415550101',
    'outgoing', 'completed', null, now(), null);
  perform public.record_call_transcript('late-2',
    '[{"at":0,"who":"User","text":"Hi"}]'::jsonb, 4);

  select * into r from public.contact_log where provider_call_id = 'late-2';
  perform pg_temp.chk(
    'THE POINT: four seconds is still not a conversation after the upgrade',
    r.kind = 'call_attempt',
    'kind = ' || coalesce(r.kind, 'null'));

  select status into st from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('...and the lead stays on New', st = 'new', st);
end $$;

-- A call that WAS believed connected and turns out to have been four seconds
-- is demoted. The correction has to run both ways or it is not a correction.
do $$
declare r record;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('demote-1', '+15415550101',
    'outgoing', 'completed', null, now(), true);
  select * into r from public.contact_log where provider_call_id = 'demote-1';
  perform pg_temp.chk('believed on the strength of answeredAt', r.kind = 'call');

  perform public.record_call_transcript('demote-1',
    '[{"at":0,"who":"User","text":"Hi"}]'::jsonb, 4);

  select * into r from public.contact_log where provider_call_id = 'demote-1';
  perform pg_temp.chk(
    'THE POINT: a four-second "conversation" is demoted once the truth arrives',
    r.kind = 'call_attempt',
    'kind = ' || coalesce(r.kind, 'null') || ' — believing answeredAt is only '
    'safe if the belief can be withdrawn');
end $$;

-- Reclassification must not touch anything that is not a call.
do $$
declare r record;
begin
  perform pg_temp.reset();

  perform public.record_contact_as(
    null, 'd0000000-0000-0000-0000-000000000001', null,
    'email', 'Review request', null, null, null, 'not-a-call', null, now());

  perform public.record_call_transcript('not-a-call',
    '[{"at":0,"who":"User","text":"Hello"}]'::jsonb, 300);

  select * into r from public.contact_log where provider_call_id = 'not-a-call';
  perform pg_temp.chk(
    'THE POINT: an email is not reclassified into a phone call',
    r.kind = 'email',
    'kind = ' || coalesce(r.kind, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 3b. Picked up by a machine
-- ---------------------------------------------------------------------------
--
-- Quo stamps an answeredAt for voicemail too, so "answered" and "connected"
-- are not the same fact. A row that says "No answer" when a message was left
-- is wrong in a way somebody acts on: they ring again instead of waiting.

do $$
declare r record;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('vm-out', '+15415550101',
    'outgoing', 'answered', 8, now());
  select * into r from public.contact_log where provider_call_id = 'vm-out';
  perform pg_temp.chk(
    'THE POINT: eight seconds of "answered" reads as a voicemail, not no answer',
    r.kind = 'call_attempt' and r.detail = 'Voicemail',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  perform public.record_quo_call('vm-in', '+15415550101',
    'incoming', 'answered', 7, now());
  select * into r from public.contact_log where provider_call_id = 'vm-in';
  perform pg_temp.chk('our voicemail answering their call says so',
    r.kind = 'call_missed' and r.detail = 'Went to our voicemail',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  -- The same thing under Quo's real vocabulary: `completed`, short, with an
  -- answeredAt. The status word carries nothing here, so p_answered is the
  -- only thing that can tell a voicemail from a phone nobody picked up.
  perform public.record_quo_call('vm-new', '+15415550101',
    'outgoing', 'completed', 6, now(), true);
  select * into r from public.contact_log where provider_call_id = 'vm-new';
  perform pg_temp.chk(
    'THE POINT: and under the status Quo actually sends, answeredAt is all there is',
    r.kind = 'call_attempt' and r.detail = 'Voicemail',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 4. The threshold, from both sides, with and without answeredAt
-- ---------------------------------------------------------------------------

do $$
begin
  -- The old two-argument shape still answers the same way. Every one of
  -- these is also asserted in verify/call-tracking.sql; they are repeated
  -- here because this file replaces the function they are about.
  perform pg_temp.chk('nine seconds is not connected',
    not public.sb_call_connected('answered', 9));
  perform pg_temp.chk('ten seconds is',
    public.sb_call_connected('answered', 10));
  perform pg_temp.chk('a null duration with no answeredAt is not connected',
    not public.sb_call_connected('answered', null));
  perform pg_temp.chk('twenty-five seconds of RINGING is not twenty-five seconds of talking',
    not public.sb_call_connected('unanswered', 25));
  perform pg_temp.chk('...nor is a long missed call',
    not public.sb_call_connected('missed', 40));

  -- The new argument, which is the one that carries the fact.
  perform pg_temp.chk('an explicit "nobody answered" beats any duration',
    not public.sb_call_connected('completed', 600, false),
    'answeredAt absent means the call was never picked up, whatever else says');
  perform pg_temp.chk('an explicit answer with no duration is believed',
    public.sb_call_connected('completed', null, true));
  perform pg_temp.chk('...but an explicit answer of four seconds is not',
    not public.sb_call_connected('completed', 4, true));

  -- And the status that started all this.
  perform pg_temp.chk('"completed" with ten seconds is connected on its own',
    public.sb_call_connected('completed', 10));
  perform pg_temp.chk('..."completed" with zero is not',
    not public.sb_call_connected('completed', 0));
end $$;

-- ---------------------------------------------------------------------------
-- 5. The old call shape still works
-- ---------------------------------------------------------------------------
--
-- p_answered is the seventh argument and it has a default, so every existing
-- six-argument caller still compiles and still means what it meant. If this
-- breaks, something in the CRM is calling a function that no longer exists.

do $$
declare n bigint;
begin
  perform pg_temp.reset();
  n := public.record_quo_call('six-args', '+15415550101', 'outgoing', 'answered', 30, now());
  perform pg_temp.chk('a six-argument call still records', n is not null);

  n := public.record_quo_call_with_notes('six-args-b', '+15415550101',
         'outgoing', 'answered', 30, now());
  perform pg_temp.chk('...and so does the wrapper', n is not null);
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — the call is read from what Quo sends, not from what we hoped';
end $$;
