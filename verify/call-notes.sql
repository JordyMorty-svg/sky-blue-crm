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

-- Assertions for db/call-notes.sql.
--
-- Run order: the call-tracking chain, then db/call-notes.sql, then this.
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- Quo sends a call and its summary as SEPARATE WEBHOOKS, generated at
-- different times, delivered in no guaranteed order. So the same facts
-- arrive in two sequences and both have to end in the same place:
--
--   call.completed then call.summary.completed   — the common case
--   call.summary.completed then call.completed   — the one that loses the
--                                                  summary if the call
--                                                  write overwrites detail
--
-- Everything else here is about not claiming more than Quo said: an empty
-- summary is not a summary, a transcript must not blank one, and a call
-- nobody owns must not invent a row to hang notes on.
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
  delete from public.call_notes;
  delete from public.leads;
  insert into public.leads (id, name, phone, status, contact_attempts)
  values ('a1111111-1111-1111-1111-111111111111', 'Dana Reyes', '(541) 555-0101', 'new', 0);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The call, then its summary
-- ---------------------------------------------------------------------------

do $$
declare d text; ok boolean;
begin
  perform pg_temp.reset();

  perform public.record_quo_call_with_notes('c1', '+15415550101', 'outgoing', 'answered', 252, now());
  select detail into d from public.contact_log where provider_call_id = 'c1';
  perform pg_temp.chk('a call with no summary yet still shows its duration',
    d = '4m 12s', coalesce(d, 'null'));

  ok := public.record_call_summary('c1',
    array['Dana wants the gutters done too.', 'Asked about a quarterly plan.'], null);
  perform pg_temp.chk('the summary says it attached', ok);

  select detail into d from public.contact_log where provider_call_id = 'c1';
  perform pg_temp.chk(
    'THE POINT: the summary lands on the call, under the duration',
    d = '4m 12s · Dana wants the gutters done too. Asked about a quarterly plan.',
    coalesce(d, 'null'));

  perform pg_temp.chk('...with the duration still FIRST',
    d like '4m 12s%',
    'a paragraph in front of it buries the one number that says whether '
    'this was a conversation or a voicemail');
end $$;

-- ---------------------------------------------------------------------------
-- 2. The summary, then the call
-- ---------------------------------------------------------------------------
--
-- The order that loses the summary if record_quo_call writes detail last
-- and nothing puts it back.

do $$
declare d text; ok boolean;
begin
  perform pg_temp.reset();

  ok := public.record_call_summary('c2', array['Left a voicemail about Tuesday.'], null);
  perform pg_temp.chk('a summary with no call yet reports that it is not showing',
    ok = false,
    'kept, but there is nothing on anybody''s timeline to show it on');

  perform pg_temp.chk('...and is kept all the same',
    exists (select 1 from public.call_notes where provider_call_id = 'c2'),
    'webhook order is not guaranteed; dropping it would lose it for good');

  perform public.record_quo_call_with_notes('c2', '+15415550101', 'outgoing', 'answered', 180, now());

  select detail into d from public.contact_log where provider_call_id = 'c2';
  perform pg_temp.chk(
    'THE POINT: the call picks up a summary that arrived before it',
    d = '3m 0s · Left a voicemail about Tuesday.',
    coalesce(d, 'null') || ' — record_quo_call writes detail itself, so '
    'without the wrapper this is where the summary gets overwritten');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Not claiming more than Quo said
-- ---------------------------------------------------------------------------

do $$
declare d text;
begin
  perform pg_temp.reset();
  perform public.record_quo_call_with_notes('c3', '+15415550101', 'outgoing', 'answered', 60, now());
  perform public.record_call_summary('c3', array['Talked about the back windows.'], null);

  perform pg_temp.chk('THE POINT: an empty summary is refused',
    public.record_call_summary('c3', '{}', null) = false,
    'Quo publishes this event for failed and absent processing too, with '
    'null content');
  perform pg_temp.chk('...and so is a null one',
    public.record_call_summary('c3', null, null) = false);

  select detail into d from public.contact_log where provider_call_id = 'c3';
  perform pg_temp.chk('...and neither wipes the summary already there',
    d = '1m 0s · Talked about the back windows.', coalesce(d, 'null'));

  perform pg_temp.chk('a transcript of silence is not a transcript',
    public.record_call_transcript('c3', '[]'::jsonb, 60) = false);
  perform pg_temp.chk('...nor is a null one',
    public.record_call_transcript('c3', null, 60) = false);
  perform pg_temp.chk('...and neither is stored',
    (select dialogue from public.call_notes where provider_call_id = 'c3') is null);

  -- CHECKED ON THE TABLE, not only on the return value.
  --
  -- Both of these return false with the guard removed as well — an empty
  -- key updates no contact_log row and a null key violates the primary
  -- key, so the return tells you nothing. What the guard actually prevents
  -- is a junk row in call_notes under an empty id, which every later
  -- summary for a call with no id would then collide with and overwrite.
  perform pg_temp.chk('a note with no call id returns false',
    public.record_call_summary('', array['something'], null) = false
      and public.record_call_summary(null, array['something'], null) = false);
  perform pg_temp.chk('THE POINT: ...and writes no row under an empty id',
    not exists (select 1 from public.call_notes where coalesce(provider_call_id, '') = ''),
    'every unidentifiable summary would share that one row and overwrite '
    'the last');
end $$;

-- ---------------------------------------------------------------------------
-- 4. The two halves do not overwrite each other
-- ---------------------------------------------------------------------------
--
-- The summary and the transcript are two events for one call, each writing
-- the same row. A plain assignment on conflict blanks whichever landed
-- first, and the symptom is a summary that vanishes a few seconds after it
-- appears.

do $$
declare n public.call_notes; d text;
begin
  perform pg_temp.reset();
  perform public.record_quo_call_with_notes('c4', '+15415550101', 'outgoing', 'answered', 252, now());
  perform public.record_call_summary('c4', array['Gutters as well.'], null);
  perform public.record_call_transcript('c4',
    '[{"identifier":"+15415550101","content":"hi","start":0,"end":2}]'::jsonb, 252);

  select * into n from public.call_notes where provider_call_id = 'c4';
  perform pg_temp.chk('THE POINT: the transcript does not blank the summary',
    n.summary is not null and jsonb_array_length(n.dialogue) = 1,
    'summary=' || coalesce(n.summary::text, 'null'));

  select detail into d from public.contact_log where provider_call_id = 'c4';
  perform pg_temp.chk('...and the timeline still reads the same',
    d = '4m 12s · Gutters as well.', coalesce(d, 'null'));

  -- And the other order.
  perform public.record_call_transcript('c5',
    '[{"identifier":"+15415550101","content":"hello","start":0,"end":1}]'::jsonb, 90);
  perform public.record_call_summary('c5', array['Booked for Friday.'], null);
  select * into n from public.call_notes where provider_call_id = 'c5';
  perform pg_temp.chk('...in either order',
    n.summary is not null and n.dialogue is not null);

  -- THE SAME EVENT TWICE, carrying different halves.
  --
  -- The cases above only prove that the summary and the transcript do not
  -- tread on each other, which they never would: each writes its own
  -- columns. What the coalesce on conflict is really for is a SECOND event
  -- of the SAME kind carrying only part of what the first one had — Quo
  -- regenerates these, and a plain assignment blanks whatever the newer
  -- payload happens to omit.
  perform public.record_call_summary('c6b', array['Gutters as well.'], array['Quote by Friday.']);
  perform public.record_call_summary('c6b', null, array['Quote by Friday.']);
  select * into n from public.call_notes where provider_call_id = 'c6b';
  perform pg_temp.chk(
    'THE POINT: a later summary event missing the words does not erase them',
    n.summary is not null and n.summary[1] = 'Gutters as well.',
    'summary = ' || coalesce(n.summary::text, 'null'));

  perform public.record_call_transcript('c7b',
    '[{"identifier":"+1","content":"a","start":0,"end":1}]'::jsonb, 120);
  perform public.record_call_transcript('c7b',
    '[{"identifier":"+1","content":"a","start":0,"end":1}]'::jsonb, null);
  select * into n from public.call_notes where provider_call_id = 'c7b';
  perform pg_temp.chk('...and one missing the duration does not erase that',
    n.duration_seconds = 120,
    'duration = ' || coalesce(n.duration_seconds::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Next steps, when somebody is on Scale
-- ---------------------------------------------------------------------------

do $$
declare d text;
begin
  perform pg_temp.reset();
  perform public.record_quo_call_with_notes('c6', '+15415550101', 'outgoing', 'answered', 90, now());
  perform public.record_call_summary('c6', array['Quoted $340.'], array['Send the quote by Friday.']);

  select detail into d from public.contact_log where provider_call_id = 'c6';
  perform pg_temp.chk('action items are shown, and labelled',
    d = '1m 30s · Quoted $340. · Next: Send the quote by Friday.',
    coalesce(d, 'null'));

  -- Business plan: summary, no action items. Null must not print as
  -- "Next: " with nothing after it.
  perform pg_temp.reset();
  perform public.record_quo_call_with_notes('c7', '+15415550101', 'outgoing', 'answered', 90, now());
  perform public.record_call_summary('c7', array['Quoted $340.'], null);
  select detail into d from public.contact_log where provider_call_id = 'c7';
  perform pg_temp.chk('THE POINT: no action items prints nothing, not an empty label',
    d = '1m 30s · Quoted $340.',
    coalesce(d, 'null') || ' — Business plan gets no action items at all');
end $$;

-- ---------------------------------------------------------------------------
-- 6. A call to somebody nobody knows
-- ---------------------------------------------------------------------------

do $$
declare kept boolean;
begin
  perform pg_temp.reset();

  -- No lead, no customer: record_quo_call writes nothing, so there is no
  -- row for the summary to decorate. It must still be kept, and must not
  -- invent one.
  perform public.record_quo_call_with_notes('c8', '+15035559999', 'outgoing', 'answered', 60, now());
  perform pg_temp.chk('a stranger''s call is still not logged',
    not exists (select 1 from public.contact_log where provider_call_id = 'c8'));

  -- TWO STATEMENTS, NOT ONE `and`.
  --
  -- The first version wrote these as a single expression:
  --   record_call_summary(...) = false AND exists (select 1 from call_notes …)
  -- and it failed. SQL does not promise to evaluate the operands of AND in
  -- the order they are written, so Postgres was free to run the EXISTS
  -- before the function that inserts the row it was looking for. A test
  -- that depends on evaluation order is a test that fails for a reason
  -- having nothing to do with the code.
  kept := public.record_call_summary('c8', array['Wrong number.'], null);
  perform pg_temp.chk('THE POINT: its summary attaches to nothing',
    kept = false,
    'there is no call row on anybody''s timeline to show it on');
  perform pg_temp.chk('...but is kept all the same',
    exists (select 1 from public.call_notes where provider_call_id = 'c8'),
    'the call row may still arrive; webhook order is not guaranteed');

  perform pg_temp.chk('...and no contact_log row was conjured for it',
    (select count(*) from public.contact_log) = 0,
    'contact_log is a history of the people in this database');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Reading them back
-- ---------------------------------------------------------------------------

do $$
declare r record; n int;
begin
  perform pg_temp.reset();
  perform public.record_quo_call_with_notes('c9', '+15415550101', 'outgoing', 'answered', 252, now());
  perform public.record_call_summary('c9', array['Gutters as well.'], null);
  perform public.record_call_transcript('c9',
    '[{"identifier":"+15415550101","content":"hi","start":0,"end":2}]'::jsonb, 252);

  select count(*) into n from public.call_notes_for('a1111111-1111-1111-1111-111111111111', null);
  perform pg_temp.chk('the notes for one person come back', n = 1, n::text);

  select * into r from public.call_notes_for('a1111111-1111-1111-1111-111111111111', null);
  perform pg_temp.chk('...with the words, the dialogue and the duration',
    r.summary is not null and r.dialogue is not null and r.duration_seconds = 252);

  -- A call with no notes is not in this list: it is a list of what was
  -- said, and a row with nothing said is not an entry in it.
  perform public.record_quo_call_with_notes('c10', '+15415550101', 'outgoing', 'unanswered', 0, now());
  select count(*) into n from public.call_notes_for('a1111111-1111-1111-1111-111111111111', null);
  perform pg_temp.chk('a call nobody summarised is not in the list', n = 1, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- 8. The browser cannot write a summary
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.chk(
    'THE POINT: record_call_summary is not callable by a signed-in user',
    not has_function_privilege('authenticated',
      'public.record_call_summary(text,text[],text[])', 'execute'),
    'the CRM could otherwise put words into a customer''s mouth and call '
    'them a transcript');

  perform pg_temp.chk('...nor record_call_transcript',
    not has_function_privilege('authenticated',
      'public.record_call_transcript(text,jsonb,integer)', 'execute'));

  perform pg_temp.chk('reading them back IS allowed',
    has_function_privilege('authenticated',
      'public.call_notes_for(uuid,uuid)', 'execute'));
end $$;

do $$ begin raise notice E'\nall ok — what was said lands on the call that was made\n'; end $$;
