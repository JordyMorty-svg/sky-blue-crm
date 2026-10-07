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

-- Assertions for db/sms-backfill.sql.
--
-- WHAT THIS IS ABOUT
-- ------------------
-- An import is a webhook that arrives late, in bulk, and more than once. All
-- three of those break assumptions the live path was allowed to make:
--
--   late    — now() is not when the message happened
--   bulk    — forty messages must not look like forty acts of outreach
--   again   — running it twice must not double the thread
--
-- Everything here is one of those three. The checks that matter most are the
-- ones proving the LIVE path still behaves exactly as it did, because a
-- migration that fixes an import by changing what the webhook does has
-- traded a visible problem for an invisible one.
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
  delete from public.sms_messages;
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;
  delete from public.customers;

  insert into public.leads (id, name, phone, status, contact_attempts, last_contacted_at)
  values ('d0000000-0000-0000-0000-000000000001', 'Dana Reyes', '(541) 555-0101',
          'contacted', 3, '2026-10-01T12:00:00Z');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Late: a message keeps the date it happened
-- ---------------------------------------------------------------------------

do $$
declare r record; c record;
begin
  perform pg_temp.reset();

  perform public.import_quo_text(
    '+15415550101', 'Sounds good, see you Tuesday', 'QM-old-1',
    '2026-08-14T17:05:00Z', false);

  select * into r from public.sms_messages where provider_sid = 'QM-old-1';

  perform pg_temp.chk(
    'THE POINT: an imported reply keeps the date it actually arrived',
    r.sent_at = '2026-08-14T17:05:00Z',
    'sent_at = ' || coalesce(r.sent_at::text, 'null') || ' — stamped now(), an '
    'August reply sorts to the bottom of the thread and the whole conversation '
    'reads as though it happened this afternoon');

  perform pg_temp.chk('...and is stored as a reply, not as something we sent',
    r.direction = 'in' and r.kind = 'inbound',
    coalesce(r.direction, 'null') || ' / ' || coalesce(r.kind, 'null'));

  perform pg_temp.chk('...attached to the person whose number it is',
    r.lead_id = 'd0000000-0000-0000-0000-000000000001');

  select * into c from public.contact_log where kind = 'text_in';
  perform pg_temp.chk(
    'THE POINT: and the timeline entry carries the same date',
    c.created_at = '2026-08-14T17:05:00Z',
    'created_at = ' || coalesce(c.created_at::text, 'null') || ' — "they '
    'replied today" about an August message is the kind of wrong somebody acts on');
end $$;

-- THE THREAD ITSELF, not the columns underneath it.
--
-- This is the check that caught the bug this whole migration exists to
-- prevent, after the migration had already shipped. p_at was being written
-- to sms_messages.sent_at — and sms_thread() orders on created_at, and the
-- bubble is stamped from created_at. So an August reply imported perfectly
-- still appeared at the bottom of the thread, dated today.
--
-- Every assertion above passed. They were all reading the column the import
-- wrote instead of the column the screen reads. Asking sms_thread() is the
-- only way to test the thing anybody actually looks at.
do $$
declare first_body text; second_body text; first_at timestamptz; n int;
begin
  if to_regproc('public.sms_thread') is null then
    raise exception 'Run db/sms-thread.sql before this file.';
  end if;

  perform pg_temp.reset();

  -- Inserted NEWEST FIRST, deliberately. Inserted in date order the rows
  -- come back in the right order whatever column is used to sort them, and
  -- the bug hides.
  -- BOTH DIRECTIONS among the old ones, because the two recorders insert
  -- separately and a test with only one of them leaves the other free to
  -- regress. The outgoing case in particular hid behind a "today" message
  -- whose import time and real time were the same.
  perform public.import_quo_text('+15415550101', 'Typed today', 'QM-t-new',
    now(), true);
  perform public.import_quo_text('+15415550101', 'Replied in August', 'QM-t-old',
    '2026-08-01T10:00:00Z', false);
  perform public.import_quo_text('+15415550101', 'Sent in July', 'QM-t-older',
    '2026-07-01T10:00:00Z', true);

  select body into second_body from (
    select body, row_number() over () as rn
      from public.sms_thread('+15415550101', 50)
  ) t where rn = 2;

  select body, created_at into first_body, first_at
    from public.sms_thread('+15415550101', 50) limit 1;

  perform pg_temp.chk(
    'THE POINT: an imported message WE sent sorts by when it happened',
    first_body = 'Sent in July',
    'the thread opens with "' || coalesce(first_body, 'null') || '" — the '
    'outgoing recorder has its own insert, and a test that only covers '
    'replies leaves it free to regress');

  perform pg_temp.chk(
    'THE POINT: and so does one they sent',
    second_body = 'Replied in August',
    'the thread opens with "' || coalesce(first_body, 'null') || '" — sms_thread() '
    'orders on created_at, so writing only sent_at leaves every imported '
    'message at the bottom of the conversation');

  perform pg_temp.chk(
    'THE POINT: ...and carries the date the thread will show',
    first_at = '2026-07-01T10:00:00Z',
    'created_at = ' || coalesce(first_at::text, 'null') || ' — the bubble is '
    'stamped from this column, not from sent_at');

  select count(*) into n from public.sms_thread('+15415550101', 50);
  perform pg_temp.chk('...with all three messages in the thread', n = 3, n || ' rows');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Again: importing twice changes nothing
-- ---------------------------------------------------------------------------

do $$
declare n int; first bigint; second bigint;
begin
  perform pg_temp.reset();

  first  := public.import_quo_text('+15415550101', 'Hello again', 'QM-dupe',
              '2026-08-15T09:00:00Z', false);
  second := public.import_quo_text('+15415550101', 'Hello again', 'QM-dupe',
              '2026-08-15T09:00:00Z', false);

  perform pg_temp.chk('the first import stores it', first is not null);
  perform pg_temp.chk(
    'THE POINT: the second import stores nothing and says so',
    second is null,
    'an import is a retry by definition, and the endpoint reads this return '
    'value to report how many were new');

  select count(*) into n from public.sms_messages where provider_sid = 'QM-dupe';
  perform pg_temp.chk('...leaving exactly one message', n = 1, n || ' rows');

  select count(*) into n from public.contact_log where kind = 'text_in';
  perform pg_temp.chk(
    'THE POINT: ...and exactly one timeline entry',
    n = 1,
    n || ' rows — the message deduped but the timeline entry did not, which '
    'is how a thread stays right while the history underneath it doubles');

  -- The same on the outgoing side.
  perform pg_temp.reset();
  first  := public.import_quo_text('+15415550101', 'Out twice', 'QM-dupe-out',
              '2026-08-15T09:00:00Z', true);
  second := public.import_quo_text('+15415550101', 'Out twice', 'QM-dupe-out',
              '2026-08-15T09:00:00Z', true);
  perform pg_temp.chk('an outgoing message deduplicates too',
    first is not null and second is null);
end $$;

-- A live inbound retry must not RAISE, which is what it used to do.
do $$
declare threw boolean := false;
begin
  perform pg_temp.reset();
  perform public.record_inbound_sms('+15415550101', 'First go', 'QM-retry');
  begin
    perform public.record_inbound_sms('+15415550101', 'First go', 'QM-retry');
  exception when others then
    threw := true;
  end;

  perform pg_temp.chk(
    'THE POINT: a repeated inbound webhook is ignored, not an error',
    not threw,
    'db/sms-app-messages.sql made provider_sid unique so a retry could not '
    'duplicate a message, and then this function inserted without catching '
    'the conflict — so the retry raised, became a 500, and Quo retried again');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Bulk: an import is not forty acts of outreach
-- ---------------------------------------------------------------------------

do $$
declare att int; seen timestamptz;
begin
  perform pg_temp.reset();

  perform public.import_quo_text('+15415550101', 'One',   'QM-b1', '2026-08-01T10:00:00Z', true);
  perform public.import_quo_text('+15415550101', 'Two',   'QM-b2', '2026-08-02T10:00:00Z', true);
  perform public.import_quo_text('+15415550101', 'Three', 'QM-b3', '2026-08-03T10:00:00Z', true);

  select contact_attempts, last_contacted_at into att, seen
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';

  perform pg_temp.chk(
    'THE POINT: importing three old messages does not count as three attempts',
    att = 3,
    'contact_attempts = ' || att || ' — it started at 3. The work already '
    'happened; counting it again inflates the number the follow-up '
    'automation reads');

  perform pg_temp.chk('...and does not move last reached out',
    seen = '2026-10-01T12:00:00Z',
    coalesce(seen::text, 'null'));
end $$;

-- ...while a message sent a minute ago still does, which is the behaviour
-- this migration must not have quietly changed.
do $$
declare att int; seen timestamptz;
begin
  perform pg_temp.reset();

  perform public.record_app_sms('+15415550101', 'Typed just now', 'QM-live',
    '2026-10-05T16:00:00Z');

  select contact_attempts, last_contacted_at into att, seen
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';

  perform pg_temp.chk(
    'THE POINT: a live message from the Quo app still counts as outreach',
    att = 4,
    'contact_attempts = ' || att || ' — a person typing a message IS the work, '
    'and it is the clearest signal the CRM gets that somebody is on this lead');

  perform pg_temp.chk('...and still moves last reached out',
    seen = '2026-10-05T16:00:00Z', coalesce(seen::text, 'null'));
end $$;

-- A late live message must never drag the date backwards.
do $$
declare seen timestamptz;
begin
  perform pg_temp.reset();
  perform public.record_app_sms('+15415550101', 'Arrived late', 'QM-late',
    '2026-09-01T10:00:00Z');

  select last_contacted_at into seen from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('an older message does not drag last reached out backwards',
    seen = '2026-10-01T12:00:00Z', coalesce(seen::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Direction, and the messages that are not messages
-- ---------------------------------------------------------------------------

do $$
declare r record; n int;
begin
  perform pg_temp.reset();

  perform public.import_quo_text('+15415550101', 'We sent this', 'QM-out',
    '2026-08-20T10:00:00Z', true);
  select * into r from public.sms_messages where provider_sid = 'QM-out';
  perform pg_temp.chk('an outgoing import is stored as ours',
    r.direction = 'out' and r.kind = 'app',
    coalesce(r.direction, 'null') || ' / ' || coalesce(r.kind, 'null'));

  select count(*) into n from public.contact_log where kind = 'text';
  perform pg_temp.chk('...with a timeline entry that reads as us talking', n = 1);

  -- Quo models a few things as messages that have no words in them: a
  -- picture, a reaction, a receipt.
  perform pg_temp.chk(
    'THE POINT: a message with no text is skipped, not stored empty',
    public.import_quo_text('+15415550101', '', 'QM-empty',
      '2026-08-21T10:00:00Z', false) is null,
    'a row of empty bubbles is worse than a gap');

  perform pg_temp.chk('...and whitespace counts as empty',
    public.import_quo_text('+15415550101', '   ', 'QM-blank',
      '2026-08-21T10:00:00Z', true) is null);

  select count(*) into n from public.sms_messages where provider_sid in ('QM-empty', 'QM-blank');
  perform pg_temp.chk('...leaving nothing behind', n = 0, n || ' rows');
end $$;

-- ---------------------------------------------------------------------------
-- 3b. WHERE IT LANDS IN THE THREAD
-- ---------------------------------------------------------------------------
--
-- THE CHECK THAT CAUGHT THE REAL BUG, and it only caught it because it calls
-- sms_thread() instead of reading the row back.
--
-- The first version of this migration set sent_at and left created_at to its
-- default of now(). Every assertion above passed. But sms_thread() ORDERS ON
-- created_at and the bubble is STAMPED from created_at — so an August reply
-- still appeared at the bottom of the conversation with today's date on it,
-- which is the exact symptom the whole migration was written to prevent.
--
-- Reading a column back proves the column was written. Only asking the
-- screen's own query proves the screen is right.

do $$
declare r record; n int;
begin
  if to_regproc('public.sms_thread') is null then
    raise exception 'Run db/sms-thread.sql before this file — these checks use it.';
  end if;

  perform pg_temp.reset();

  -- Written in the wrong order on purpose: newest first, oldest second, the
  -- way an import actually arrives behind messages the CRM already had.
  perform public.import_quo_text('+15415550101', 'TODAY', 's-new', now(), true);
  perform public.import_quo_text('+15415550101', 'AUGUST', 's-old',
    '2026-08-01T10:00:00Z', false);

  select count(*) into n from public.sms_thread('+15415550101', 50);
  perform pg_temp.chk('both messages are in the thread', n = 2, n || ' rows');

  select * into r from public.sms_thread('+15415550101', 50) limit 1;

  perform pg_temp.chk(
    'THE POINT: the older message comes FIRST in the thread',
    r.body = 'AUGUST',
    'first row is "' || coalesce(r.body, 'null') || '" — inserted second, so '
    'anything ordering on insertion time puts it last');

  perform pg_temp.chk(
    'THE POINT: ...and carries the date it actually happened',
    r.created_at = '2026-08-01T10:00:00Z',
    'created_at = ' || coalesce(r.created_at::text, 'null') || ' — this is the '
    'column the thread orders on AND the one the bubble is stamped from. '
    'Setting only sent_at fixes a column nothing on the screen reads');
end $$;

-- ---------------------------------------------------------------------------
-- 4b. A page at a time
-- ---------------------------------------------------------------------------

do $$
declare n int; c int;
begin
  perform pg_temp.reset();

  n := public.import_quo_texts($j$[
    {"phone": "+15415550101", "body": "Morning",      "sid": "QM-p1", "at": "2026-08-01T15:00:00Z", "outgoing": true},
    {"phone": "+15415550101", "body": "Hi there",     "sid": "QM-p2", "at": "2026-08-01T15:05:00Z", "outgoing": false},
    {"phone": "+15415550101", "body": "Tuesday work?","sid": "QM-p3", "at": "2026-08-01T15:06:00Z", "outgoing": true}
  ]$j$::jsonb);

  perform pg_temp.chk('a page imports and says how many were new', n = 3, n || ' imported');

  select count(*) into c from public.sms_messages;
  perform pg_temp.chk('...and all three are there', c = 3, c || ' rows');

  -- Run it again. This is what pressing the button twice does.
  n := public.import_quo_texts($j$[
    {"phone": "+15415550101", "body": "Morning",      "sid": "QM-p1", "at": "2026-08-01T15:00:00Z", "outgoing": true},
    {"phone": "+15415550101", "body": "Hi there",     "sid": "QM-p2", "at": "2026-08-01T15:05:00Z", "outgoing": false},
    {"phone": "+15415550101", "body": "New one",      "sid": "QM-p4", "at": "2026-08-02T09:00:00Z", "outgoing": false}
  ]$j$::jsonb);

  perform pg_temp.chk(
    'THE POINT: a second run counts only what was actually new',
    n = 1,
    n || ' reported new — re-importing is how a conversation that has moved '
    'on gets caught up, so "already had it" is not an error and must not be '
    'counted as an import');

  select count(*) into c from public.sms_messages;
  perform pg_temp.chk('...and nothing doubled', c = 4, c || ' rows');
end $$;

-- ONE BAD ROW MUST NOT LOSE THE PAGE.
do $$
declare n int; c int;
begin
  perform pg_temp.reset();

  n := public.import_quo_texts($j$[
    {"phone": "+15415550101", "body": "Good one",  "sid": "QM-g1", "at": "2026-08-01T15:00:00Z", "outgoing": false},
    {"phone": "+15415550101", "body": "Bad date",  "sid": "QM-bad", "at": "not a date",          "outgoing": false},
    {"phone": "+15415550101", "body": "Also good", "sid": "QM-g2", "at": "2026-08-01T15:10:00Z", "outgoing": true}
  ]$j$::jsonb);

  perform pg_temp.chk(
    'THE POINT: a message Quo sent with a date nobody can parse loses only itself',
    n = 2,
    n || ' imported of 3 — a page that dies on its worst row imports nothing, '
    'and the person pressing the button cannot tell that from "no history"');

  select count(*) into c from public.sms_messages where provider_sid in ('QM-g1', 'QM-g2');
  perform pg_temp.chk('...and the good ones are stored', c = 2, c || ' rows');
end $$;

-- An empty page is not an error.
do $$
begin
  perform pg_temp.reset();
  perform pg_temp.chk('an empty page imports nothing, quietly',
    public.import_quo_texts('[]'::jsonb) = 0);
  perform pg_temp.chk('...and so does a null one',
    public.import_quo_texts(null) = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 5. The old call shapes still work
-- ---------------------------------------------------------------------------
--
-- Both recorders gained an argument. Every existing caller passes fewer, and
-- the defaults have to mean exactly what the absence of those arguments
-- meant before — otherwise the live webhook changes behaviour on the day an
-- unrelated import feature ships.

do $$
declare r record; att int;
begin
  perform pg_temp.reset();

  perform public.record_inbound_sms('+15415550101', 'Three args', 'QM-3');
  select * into r from public.sms_messages where provider_sid = 'QM-3';
  perform pg_temp.chk('a three-argument inbound call still records', r.id is not null);
  perform pg_temp.chk('...dated now, as it always was',
    r.sent_at > now() - interval '1 minute');

  perform public.record_app_sms('+15415550101', 'Four args', 'QM-4');
  select contact_attempts into att from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: a four-argument app message still counts, as it always did',
    att = 4,
    'contact_attempts = ' || att || ' — the new p_bump argument defaults to '
    'true precisely so this does not change');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Repairing what the first version of this file got wrong
-- ---------------------------------------------------------------------------
--
-- Those rows cannot fix themselves: import_quo_text() deduplicates on
-- provider_sid, so pressing the button again skips them. The repair is what
-- re-running the migration is for.

do $$
declare n int; r record;
begin
  perform pg_temp.reset();

  -- Exactly what the first version wrote: the real time in sent_at, today in
  -- created_at.
  insert into public.sms_messages
    (direction, phone, body, kind, status, provider_sid, created_at, sent_at)
  values
    ('in',  '+15415550101', 'Old reply', 'inbound', 'received', 'r-1',
     now(), '2026-08-01T10:00:00Z'),
    ('out', '+15415550101', 'Old send',  'app',     'sent',     'r-2',
     now(), '2026-08-02T11:00:00Z');

  -- And a message the CRM sent itself, where the two columns are two
  -- different facts: queued at one time, accepted by Quo a moment later.
  insert into public.sms_messages
    (direction, phone, body, kind, status, provider_sid, created_at, sent_at)
  values
    ('out', '+15415550101', 'A quote', 'quote', 'sent', 'r-3',
     '2026-09-01T09:00:00Z', '2026-09-01T09:00:04Z');

  n := public.repair_imported_text_times();
  perform pg_temp.chk('the repair reports what it moved', n = 2, n || ' rows');

  select * into r from public.sms_messages where provider_sid = 'r-1';
  perform pg_temp.chk(
    'THE POINT: an already-imported reply is moved to when it happened',
    r.created_at = '2026-08-01T10:00:00Z',
    'created_at = ' || coalesce(r.created_at::text, 'null') || ' — these rows '
    'cannot fix themselves: the importer skips a message it already has');

  select * into r from public.sms_messages where provider_sid = 'r-2';
  perform pg_temp.chk('...and so is an already-imported outgoing one',
    r.created_at = '2026-08-02T11:00:00Z', coalesce(r.created_at::text, 'null'));

  select * into r from public.sms_messages where provider_sid = 'r-3';
  perform pg_temp.chk(
    'THE POINT: a message the CRM sent itself is left alone',
    r.created_at = '2026-09-01T09:00:00Z',
    'created_at = ' || coalesce(r.created_at::text, 'null') || ' — for a CRM '
    'send, created_at is when it was queued and sent_at is when Quo accepted '
    'it. They are two facts, not one fact stored badly');

  -- Running it again must find nothing, or it is not safe to leave in a
  -- migration file somebody re-runs.
  perform pg_temp.chk('running the repair again does nothing',
    public.repair_imported_text_times() = 0);
end $$;

-- RE-RUNNING THE MIGRATION IS THE FIX, so that is what this checks.
--
-- Everything above calls repair_imported_text_times() directly, which proves
-- the function works and says nothing about whether applying the file calls
-- it. A mutation run deleted the call from the do-block at the end of
-- db/sms-backfill.sql and every check still passed — while the instruction
-- given to the person with the broken rows ("re-run the migration") had
-- quietly stopped working.

do $$
begin
  perform pg_temp.reset();
  insert into public.sms_messages
    (direction, phone, body, kind, status, provider_sid, created_at, sent_at)
  values
    ('in', '+15415550101', 'Needs moving', 'inbound', 'received', 'apply-1',
     now(), '2026-07-04T12:00:00Z');
end $$;

\i db/sms-backfill.sql

do $$
declare r record;
begin
  select * into r from public.sms_messages where provider_sid = 'apply-1';
  perform pg_temp.chk(
    'THE POINT: applying the migration repairs the rows, without being asked twice',
    r.created_at = '2026-07-04T12:00:00Z',
    'created_at = ' || coalesce(r.created_at::text, 'null') || ' — "re-run '
    'db/sms-backfill.sql" is the whole instruction, and it has to be true');
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — history imports as history, and the live path is untouched';
end $$;
