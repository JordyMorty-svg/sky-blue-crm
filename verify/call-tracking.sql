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

-- Assertions for db/call-tracking.sql.
--
-- Run order: verify/sms-fixture.sql, verify/call-fixture.sql, db/sms.sql,
-- db/sms-delivery.sql, db/email-delivery.sql, db/delivery-controls.sql,
-- db/contact-history.sql, db/sms-app-messages.sql, db/sms-thread.sql,
-- db/call-tracking.sql, then this.
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- The old Call button logged a call on CLICK. On a laptop, where a tel:
-- link opens nothing, pressing it logged a call. On a phone, pressing it
-- and then pressing cancel logged a call. Ringing out logged a call.
-- contact_attempts — the number the follow-up automation reads and the
-- number a person reads before deciding whether to chase somebody again —
-- was counting button presses.
--
-- So the whole file comes down to one question asked several ways: DOES A
-- ROW APPEAR ONLY WHEN A CALL HAPPENED, AND DOES IT SAY WHAT ACTUALLY
-- HAPPENED? Two failures matter and they are not symmetrical:
--
--   a call invented   — the history lies, and somebody decides not to ring
--                       a lead because the CRM says they already did
--   a call lost       — the history is thin, and somebody rings twice
--
-- The first is much worse, which is why more of this file is about calls
-- that must NOT be written than calls that must.
--
-- Checks marked THE POINT are the ones this file exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

-- A clean board: one lead on 'new', one number, nothing logged.
create or replace function pg_temp.reset()
returns void language plpgsql as $$
begin
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;
  delete from public.customers;

  insert into public.leads (id, name, phone, status, contact_attempts)
  values ('d0000000-0000-0000-0000-000000000001', 'Dana Reyes', '(541) 555-0101', 'new', 0);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The calls that must NOT be written
-- ---------------------------------------------------------------------------
--
-- First in the file, deliberately. This is the bug being fixed, and every
-- other section is about what to do once a call is real.

do $$
declare n int; st text; att int;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('x1', '+15415550101', 'outgoing', 'failed', 0, now());
  perform public.record_quo_call('x2', '+15415550101', 'outgoing', 'abandoned', 0, now());
  perform public.record_quo_call('x3', '+15415550101', 'outgoing', 'ai-handled', 30, now());
  perform public.record_quo_call('x4', '+15415550101', 'outgoing', 'unknown', 0, now());

  select count(*) into n from public.contact_log;
  perform pg_temp.chk(
    'THE POINT: a call that never connected and never rang is not a call',
    n = 0,
    'got ' || n || ' rows — failed, abandoned, ai-handled and unknown are the '
    'old optimistic logging arriving by a different route');

  select status, contact_attempts into st, att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('...and none of them counted as an attempt',
    att = 0, 'contact_attempts = ' || att);
  perform pg_temp.chk('...and none of them moved the lead',
    st = 'new', 'status = ' || st);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Answered by voicemail is not a conversation
-- ---------------------------------------------------------------------------
--
-- Quo reports `answered` for a call that voicemail picked up. Eleven
-- seconds of a recorded greeting is not "I spoke to them", and treating it
-- as one moves a lead to Contacted that nobody has contacted.

do $$
declare r record; st text;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('v1', '+15415550101', 'outgoing', 'answered', 8, now());

  select status into st from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: eight seconds of "answered" does not advance the lead',
    st = 'new',
    'status = ' || st || ' — that is a voicemail greeting, not a conversation');

  select * into r from public.contact_log where provider_call_id = 'v1';
  perform pg_temp.chk(
    'THE POINT: but the call is NOT thrown away — it happened',
    r.kind = 'call_attempt',
    'kind = ' || coalesce(r.kind, 'null') || ' — discarding it is the opposite '
    'failure from the one being fixed: a real call somebody really made, gone');
  perform pg_temp.chk('...and reads as what it was',
    r.detail = 'Voicemail', 'detail = ' || coalesce(r.detail, 'null'));

  -- Inbound, picked up by our voicemail. Quo says `answered`; from the
  -- customer's side nobody was there, which is a missed call.
  perform public.record_quo_call('v2', '+15415550101', 'incoming', 'answered', 7, now());
  select * into r from public.contact_log where provider_call_id = 'v2';
  perform pg_temp.chk('our voicemail answering their call is a missed call',
    r.kind = 'call_missed' and r.detail = 'Went to our voicemail',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));

  -- The threshold itself, from both sides. A boundary tested on one side
  -- only is a boundary nobody has checked.
  perform pg_temp.chk('nine seconds is not connected',
    not public.sb_call_connected('answered', 9));
  perform pg_temp.chk('ten seconds is',
    public.sb_call_connected('answered', 10));
  perform pg_temp.chk('a null duration is not connected whatever the status says',
    not public.sb_call_connected('answered', null));

  -- THE STATUS HAS TO BE CHECKED TOO, not just the duration.
  --
  -- Quo's `duration` on an unanswered call is the time it spent ringing,
  -- and a phone rings for twenty-five seconds before voicemail. Judged on
  -- duration alone, every single call that nobody answered would read as a
  -- conversation and move the lead to Contacted — which is the original
  -- bug, restored in full, by a function written to prevent it.
  perform pg_temp.chk(
    'THE POINT: twenty-five seconds of RINGING is not twenty-five seconds of talking',
    not public.sb_call_connected('unanswered', 25),
    'a phone rings for about that long before voicemail picks up');
  perform pg_temp.chk('...nor is a long missed call',
    not public.sb_call_connected('missed', 40));
  perform pg_temp.chk('...and a status nobody has seen before is not a conversation',
    not public.sb_call_connected('some-new-status-quo-added', 300),
    'the documented list already ends in "unknown"; it will grow');
end $$;

-- ---------------------------------------------------------------------------
-- 3. A call that happened
-- ---------------------------------------------------------------------------

do $$
declare r record; st text; att int; seen timestamptz;
begin
  perform pg_temp.reset();

  perform public.record_quo_call(
    'c1', '+15415550101', 'outgoing', 'answered', 252,
    now() - interval '20 minutes');

  select * into r from public.contact_log where provider_call_id = 'c1';
  perform pg_temp.chk('a connected call is logged as a call', r.kind = 'call');
  perform pg_temp.chk('...with how long it lasted', r.detail = '4m 12s',
    'detail = ' || coalesce(r.detail, 'null'));
  perform pg_temp.chk('...and which way it went', r.direction = 'out');
  perform pg_temp.chk('...and Quo''s own word for the outcome', r.outcome = 'answered');
  perform pg_temp.chk('...attached to the person', r.lead_id = 'd0000000-0000-0000-0000-000000000001');
  perform pg_temp.chk('...with no profile as the actor, because Quo placed it',
    r.changed_by is null);

  -- WHEN IT HAPPENED, not when the webhook arrived. Quo retries anything
  -- that is not a 2xx, so a hook delivered late must not move the call.
  perform pg_temp.chk('THE POINT: the row is stamped with Quo''s time, not ours',
    r.created_at < now() - interval '15 minutes',
    'created_at = ' || r.created_at::text);

  select status, contact_attempts, last_contacted_at into st, att, seen
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('a connected call advances a new lead', st = 'contacted',
    'status = ' || st);
  perform pg_temp.chk('...and counts as an attempt', att = 1, 'got ' || att);
  perform pg_temp.chk('...and the move is recorded on the same row',
    r.from_status = 'new' and r.to_status = 'contacted',
    coalesce(r.from_status, 'null') || ' -> ' || coalesce(r.to_status, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Rang out: an attempt, not a contact
-- ---------------------------------------------------------------------------
--
-- The distinction the old button could not make. Both of these used to
-- write the identical row and move the lead.

do $$
declare st text; att int; r record;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('n1', '+15415550101', 'outgoing', 'unanswered', 0, now());
  perform public.record_quo_call('n2', '+15415550101', 'outgoing', 'no-answer', 0, now());

  select status, contact_attempts into st, att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';

  perform pg_temp.chk(
    'THE POINT: ringing out twice does not make somebody "contacted"',
    st = 'new',
    'status = ' || st || ' — the board would show them as handled when nobody '
    'has spoken to them');
  perform pg_temp.chk('...but both attempts are counted', att = 2, 'got ' || att);

  select * into r from public.contact_log where provider_call_id = 'n1';
  perform pg_temp.chk('...and read as what they were',
    r.kind = 'call_attempt' and r.detail = 'No answer',
    coalesce(r.kind, 'null') || ' / ' || coalesce(r.detail, 'null'));
  perform pg_temp.chk('...with no status move written on them',
    r.from_status is null and r.to_status is null);
end $$;

-- ---------------------------------------------------------------------------
-- 5. They rang US
-- ---------------------------------------------------------------------------

do $$
declare r record; att int; st text; seen timestamptz;
begin
  perform pg_temp.reset();
  update public.leads set last_contacted_at = null
   where id = 'd0000000-0000-0000-0000-000000000001';

  perform public.record_quo_call('i1', '+15415550101', 'incoming', 'unanswered', 0, now());

  select * into r from public.contact_log where provider_call_id = 'i1';
  perform pg_temp.chk('a missed inbound call is on the timeline',
    r.kind = 'call_missed' and r.direction = 'in',
    coalesce(r.kind, 'null'));

  select contact_attempts, last_contacted_at into att, seen
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: them ringing us is not us reaching out',
    att = 0 and seen is null,
    'attempts=' || att || ' last_contacted_at=' || coalesce(seen::text, 'null')
    || ' — counting their call as our outreach inflates the one number the '
    'follow-up automation reads');

  -- An inbound call that WAS answered is a conversation, whoever dialled.
  perform public.record_quo_call('i2', '+15415550101', 'incoming', 'answered', 180, now());
  select * into r from public.contact_log where provider_call_id = 'i2';
  perform pg_temp.chk('a call they made that we answered reads as theirs, not ours',
    r.kind = 'call_in',
    'kind = ' || coalesce(r.kind, 'null') || ' — "Called" on this row would say '
    'Sky Blue rang them, which is the opposite of what happened');
  select status, contact_attempts into st, att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('an inbound call we answered still advances the lead',
    st = 'contacted', 'status = ' || st);
  perform pg_temp.chk('...and still is not an outreach attempt',
    att = 0, 'got ' || att);

  -- A failed inbound is not "they tried to reach us".
  perform public.record_quo_call('i3', '+15415550101', 'incoming', 'failed', 0, now());
  perform pg_temp.chk('a failed inbound call is not a missed call',
    not exists (select 1 from public.contact_log where provider_call_id = 'i3'));
end $$;

-- ---------------------------------------------------------------------------
-- 6. Quo retries, and the same call must stay one row
-- ---------------------------------------------------------------------------

do $$
declare n int; att int;
begin
  perform pg_temp.reset();

  perform public.record_quo_call('r1', '+15415550101', 'outgoing', 'answered', 120, now());
  perform public.record_quo_call('r1', '+15415550101', 'outgoing', 'answered', 120, now());
  perform public.record_quo_call('r1', '+15415550101', 'outgoing', 'answered', 120, now());

  select count(*) into n from public.contact_log where provider_call_id = 'r1';
  perform pg_temp.chk('THE POINT: three deliveries of one call are one row',
    n = 1, 'got ' || n || ' — Quo retries anything that is not a 2xx');

  select contact_attempts into att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('...and one attempt, not three', att = 1, 'got ' || att);

  -- A retry returns null so the webhook can tell "new" from "seen before"
  -- without a second query.
  perform pg_temp.chk('a repeat says nothing was written',
    public.record_quo_call('r1', '+15415550101', 'outgoing', 'answered', 120, now()) is null);

  -- No id, no dedupe. Writing it anyway is the duplicate problem with extra
  -- steps, so it is refused.
  perform pg_temp.chk('a call with no id is refused rather than written',
    public.record_quo_call('', '+15415550101', 'outgoing', 'answered', 120, now()) is null);
  perform pg_temp.chk('...including a null one',
    public.record_quo_call(null, '+15415550101', 'outgoing', 'answered', 120, now()) is null);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Whose call was it
-- ---------------------------------------------------------------------------

do $$
declare r record; n int;
begin
  perform pg_temp.reset();

  -- The number arrives from Quo in E.164 and the lead row holds whatever
  -- somebody typed. This is the bug db/sms-app-messages.sql fixed for texts;
  -- a call logged against nobody is the same bug on a different table.
  perform public.record_quo_call('w1', '+15415550101', 'outgoing', 'answered', 60, now());
  select * into r from public.contact_log where provider_call_id = 'w1';
  perform pg_temp.chk(
    'THE POINT: an E.164 number finds a lead whose phone was typed by hand',
    r.lead_id = 'd0000000-0000-0000-0000-000000000001',
    'lead_id = ' || coalesce(r.lead_id::text, 'null') || ' — orphaned, which is '
    'a call on nobody''s history');

  -- Both ids when the person is both.
  insert into public.customers (id, name, phone)
  values ('e0000000-0000-0000-0000-000000000001', 'Dana Reyes', '541-555-0101');

  perform public.record_quo_call('w2', '+15415550101', 'outgoing', 'answered', 60, now());
  select * into r from public.contact_log where provider_call_id = 'w2';
  perform pg_temp.chk('...and stamps the customer as well as the lead',
    r.lead_id is not null and r.customer_id = 'e0000000-0000-0000-0000-000000000001',
    'customer_id = ' || coalesce(r.customer_id::text, 'null'));

  -- A stranger. contact_log is a history of the people in this database.
  select count(*) into n from public.contact_log;
  perform pg_temp.chk('a number nobody owns is not written down',
    public.record_quo_call('w3', '+15035559999', 'outgoing', 'answered', 60, now()) is null);
  perform pg_temp.chk('...and left no row behind',
    (select count(*) from public.contact_log) = n);
end $$;

-- ---------------------------------------------------------------------------
-- 8. record_contact() still means exactly what it meant
-- ---------------------------------------------------------------------------
--
-- Its body moved down a level into record_contact_as(). Everything already
-- calling it — the quote flow, the email logging, a note typed by hand —
-- must be unable to tell.

do $$
declare r record; st text; att int; actor uuid;
begin
  perform pg_temp.reset();

  insert into public.profiles (id, full_name) values
    ('f0000000-0000-0000-0000-000000000001', 'Jordan M')
  on conflict (id) do update set full_name = excluded.full_name;
  perform set_config('test.uid', 'f0000000-0000-0000-0000-000000000001', true);

  perform public.record_contact(
    'd0000000-0000-0000-0000-000000000001', null, 'call', null);

  select * into r from public.contact_log order by id desc limit 1;
  perform pg_temp.chk('record_contact still records who did it',
    r.changed_by = 'f0000000-0000-0000-0000-000000000001');
  perform pg_temp.chk('...and still has no call columns to fill',
    r.provider_call_id is null and r.direction is null and r.duration_seconds is null);

  select status, contact_attempts into st, att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: a hand-logged contact still advances and still counts',
    st = 'contacted' and att = 1,
    'status=' || st || ' attempts=' || att
    || ' — p_reached defaults to null, which must keep meaning "not a call, '
    'assume we reached them"');

  -- An email is not a call and must not be judged as one.
  perform public.record_contact(
    'd0000000-0000-0000-0000-000000000001', null, 'email', 'quote sent');
  select contact_attempts into att
    from public.leads where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('an email still counts as reaching out', att = 2, 'got ' || att);
end $$;

-- ---------------------------------------------------------------------------
-- 9. The browser cannot write a call it invented
-- ---------------------------------------------------------------------------
--
-- record_contact_as() takes any actor, any timestamp and any outcome, which
-- is the point of it and exactly why a signed-in browser must not reach it.
-- The CRM gets record_contact(), which supplies auth.uid() and cannot be
-- talked out of it.

do $$
begin
  perform pg_temp.chk(
    'THE POINT: record_contact_as is not callable by a signed-in user',
    not has_function_privilege('authenticated',
      'public.record_contact_as(uuid,uuid,uuid,text,text,text,text,integer,text,boolean,timestamptz)',
      'execute'),
    'the browser could then log a four-minute call that never happened, '
    'attributed to anybody, dated anything');

  perform pg_temp.chk('...nor by an anonymous one',
    not has_function_privilege('anon',
      'public.record_contact_as(uuid,uuid,uuid,text,text,text,text,integer,text,boolean,timestamptz)',
      'execute'));

  perform pg_temp.chk('record_contact still is',
    has_function_privilege('authenticated',
      'public.record_contact(uuid,uuid,text,text)', 'execute'));
end $$;

-- ---------------------------------------------------------------------------
-- 10. One person, two spellings of their number
-- ---------------------------------------------------------------------------
--
-- contact_identity() used to match on sb_phone_digits(), so "(541)
-- 555-0101" and "+1 541 555 0101" were two different humans with two
-- separate histories. Found while writing this file.

do $$
declare ident record;
begin
  perform pg_temp.reset();

  insert into public.leads (id, name, phone, status)
  values ('d0000000-0000-0000-0000-000000000002', 'Dana Reyes', '+1 541 555 0101', 'new');

  select * into ident
    from public.contact_identity('d0000000-0000-0000-0000-000000000001', null);

  perform pg_temp.chk(
    'THE POINT: one person typed two ways is one person',
    'd0000000-0000-0000-0000-000000000002' = any(ident.lead_ids),
    'lead_ids = ' || ident.lead_ids::text || ' — matched on sb_phone_digits '
    'these are two humans and the history splits down the middle');

  -- And a lead with no number at all matches nobody, rather than matching
  -- everybody else who also has no number.
  insert into public.leads (id, name, phone, status)
  values ('d0000000-0000-0000-0000-000000000003', 'No Number', null, 'new');
  insert into public.leads (id, name, phone, status)
  values ('d0000000-0000-0000-0000-000000000004', 'Also None', '', 'new');

  insert into public.customers (id, name, phone)
  values ('e0000000-0000-0000-0000-000000000009', 'Nobody In Particular', null);

  select * into ident
    from public.contact_identity('d0000000-0000-0000-0000-000000000003', null);

  -- Both halves of contact_identity, because it resolves leads and
  -- customers in two separate queries and a test that only reads one of
  -- them leaves the other free to be wrong. The first version of this
  -- section asserted on lead_ids alone, and the customers clause could be
  -- broken without anything noticing.
  perform pg_temp.chk('THE POINT: no phone matches nobody, not everybody else with no phone',
    not ('d0000000-0000-0000-0000-000000000004' = any(ident.lead_ids)),
    'lead_ids = ' || ident.lead_ids::text || ' — every lead with a blank phone '
    'would share one history');
  perform pg_temp.chk('...on the customer side too',
    not ('e0000000-0000-0000-0000-000000000009' = any(ident.customer_ids)),
    'customer_ids = ' || ident.customer_ids::text);
end $$;

do $$ begin raise notice E'\nall ok — a call is logged when a call happened\n'; end $$;
