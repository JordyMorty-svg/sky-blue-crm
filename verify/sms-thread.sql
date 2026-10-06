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

-- Assertions for db/sms-thread.sql.
--
-- Run order: verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,
-- db/contact-history.sql, db/sms-app-messages.sql, db/sms-thread.sql,
-- then this.
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- Two things, and they pull in opposite directions.
--
-- ONE: the thread finds the whole conversation. The same human's messages
-- are stored under at least three spellings of their number — "+15415550101"
-- from claim_sms, "5415550101" from a hand-typed lead row, and whatever the
-- Quo webhook sent — and a thread that matches only one of them shows a
-- fragment and looks like the complete story. That is worse than showing
-- nothing, because nobody checks a thread that looks complete.
--
-- TWO: it finds NOBODY ELSE. This panel sits on a customer's record and
-- shows a private conversation. One stranger's text in it is a different
-- and much worse class of bug than a missing one.
--
-- Checks marked THE POINT are the ones this file exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. One human, three spellings of their number
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
  first_body text;
  last_body  text;
begin
  delete from public.sms_messages;
  delete from public.contact_log;
  delete from public.leads;
  delete from public.customers;

  insert into public.leads (id, name, phone, status)
  values ('a0000000-0000-0000-0000-000000000001', 'Dana Reyes', '(541) 555-0101', 'new');

  -- As claim_sms() stores it.
  insert into public.sms_messages (direction, phone, body, kind, status, created_at)
  values ('out', '+15415550101', 'first', 'quote', 'sent', now() - interval '3 hours');

  -- As the inbound webhook stored it before sb_phone_key existed.
  insert into public.sms_messages (direction, phone, body, kind, status, created_at)
  values ('in', '15415550101', 'second', 'inbound', 'received', now() - interval '2 hours');

  -- As somebody typed it into the lead row.
  insert into public.sms_messages (direction, phone, body, kind, status, created_at)
  values ('out', '5415550101', 'third', 'manual', 'sent', now() - interval '1 hour');

  select count(*) into n from public.sms_thread('(541) 555-0101');
  perform pg_temp.chk(
    'THE POINT: every spelling of one number is one conversation',
    n = 3,
    'got ' || n || ' of 3 — a thread that matches only the E.164 form shows a '
    'fragment and looks complete');

  -- Asked for by any of the three spellings, the answer is the same three.
  select count(*) into n from public.sms_thread('+15415550101');
  perform pg_temp.chk('...asked for in E.164', n = 3, 'got ' || n);
  select count(*) into n from public.sms_thread('5415550101');
  perform pg_temp.chk('...asked for as ten digits', n = 3, 'got ' || n);
  select count(*) into n from public.sms_thread('1-541-555-0101');
  perform pg_temp.chk('...asked for with a country code and dashes', n = 3, 'got ' || n);

  select body into first_body from public.sms_thread('5415550101') limit 1;
  select body into last_body from public.sms_thread('5415550101')
    order by created_at desc limit 1;
  perform pg_temp.chk('oldest first, like every thread anybody reads',
    first_body = 'first' and last_body = 'third',
    'first=' || first_body || ' last=' || last_body);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Nobody else's conversation
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
  leaked text;
begin
  insert into public.sms_messages (direction, phone, body, kind, status)
  values ('in', '+15415559999', 'WRONG PERSON', 'inbound', 'received');

  select count(*) into n from public.sms_thread('5415550101');
  perform pg_temp.chk(
    'THE POINT: a different number is a different conversation',
    n = 3,
    'got ' || n || ' — somebody else''s text is in this customer''s thread');

  -- The near miss, which is the one a digits-based match would get wrong:
  -- same ten digits with a different country code is a different person.
  insert into public.sms_messages (direction, phone, body, kind, status)
  values ('in', '+445415550101', 'ALSO WRONG', 'inbound', 'received');

  select string_agg(body, ',') into leaked
  from public.sms_thread('5415550101')
  where body in ('WRONG PERSON', 'ALSO WRONG');

  perform pg_temp.chk('...including a foreign number with the same digits',
    leaked is null, 'leaked: ' || coalesce(leaked, ''));

  delete from public.sms_messages where body in ('WRONG PERSON', 'ALSO WRONG');
end $$;

-- ---------------------------------------------------------------------------
-- 3. A number that is not a number matches NOTHING
-- ---------------------------------------------------------------------------
--
-- THE PREMISE, not a guard.
--
-- sms_thread() has no early return for an unparseable number, deliberately
-- — see the long note in db/sms-thread.sql. It is safe because
-- sb_phone_digits() returns NULL rather than '' for a string with no digits
-- in it, so the key is null and `= null` matches nothing, junk rows
-- included.
--
-- That is a fact about a function in a DIFFERENT file, which is exactly the
-- kind of thing that gets changed by somebody who has never read this one.
-- So it is asserted directly: make sb_phone_digits() return an empty string
-- and this section goes red, instead of a stranger's text quietly appearing
-- in a customer's private conversation.

do $$
declare n int;
begin
  perform pg_temp.chk(
    'THE POINT: a string with no digits in it keys to null, not to empty',
    public.sb_phone_key('ask for Dave') is null and public.sb_phone_key('') is null,
    'key=' || coalesce(quote_literal(public.sb_phone_key('ask for Dave')), 'null')
    || ' — if this is '''' then every junk row matches every junk lookup');

  insert into public.sms_messages (direction, phone, body, kind, status)
  values ('in', 'call me on the landline', 'JUNK ROW', 'inbound', 'received');

  select count(*) into n from public.sms_thread('');
  perform pg_temp.chk('THE POINT: an empty number matches nothing, not everything',
    n = 0, 'got ' || n || ' rows for an empty number');

  select count(*) into n from public.sms_thread(null);
  perform pg_temp.chk('...and so does a null one', n = 0, 'got ' || n);

  select count(*) into n from public.sms_thread('not a phone number at all');
  perform pg_temp.chk('...and so does a sentence somebody typed in the phone field',
    n = 0, 'got ' || n);

  delete from public.sms_messages where body = 'JUNK ROW';
end $$;

-- ---------------------------------------------------------------------------
-- 4. The limit takes the NEWEST, not the oldest
-- ---------------------------------------------------------------------------
--
-- Backwards, this is the worst kind of wrong: the thread renders, scrolls,
-- looks entirely normal, and shows the three oldest messages from 2024 while
-- the reply you are answering is not in it.

do $$
declare
  n int;
  newest text;
begin
  select count(*) into n from public.sms_thread('5415550101', 2);
  perform pg_temp.chk('the limit limits', n = 2, 'got ' || n);

  select body into newest from public.sms_thread('5415550101', 2)
    order by created_at desc limit 1;
  perform pg_temp.chk('THE POINT: a limited thread keeps the NEWEST messages',
    newest = 'third',
    'got ' || newest || ' — showing the oldest would hide the reply being answered');

  select count(*) into n from public.sms_thread('5415550101', 0);
  perform pg_temp.chk('a limit of zero still returns one rather than nothing',
    n = 1, 'got ' || n);
end $$;

-- ---------------------------------------------------------------------------
-- 5. What each bubble needs to render
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  insert into public.profiles (id, full_name)
  values ('b0000000-0000-0000-0000-000000000001', 'Hayden M')
  on conflict (id) do update set full_name = excluded.full_name;

  update public.sms_messages
     set sent_by = 'b0000000-0000-0000-0000-000000000001'
   where body = 'third';

  select * into r from public.sms_thread('5415550101') where body = 'third';
  perform pg_temp.chk('an outgoing message says who typed it',
    r.sent_by = 'Hayden M', coalesce(r.sent_by, 'null'));

  select * into r from public.sms_thread('5415550101') where body = 'second';
  perform pg_temp.chk('an incoming one has no sender to name',
    r.sent_by is null and r.direction = 'in');

  -- delivered_at, which is a TIMESTAMP and not a status on purpose: see
  -- db/delivery-controls.sql. A row is 'sent' AND delivered at once, and a
  -- thread that read delivery off `status` would never show a tick.
  update public.sms_messages set delivered_at = now() where body = 'first';
  select * into r from public.sms_thread('5415550101') where body = 'first';
  perform pg_temp.chk('THE POINT: delivery is read from delivered_at, not from status',
    r.delivered_at is not null and r.status = 'sent',
    'status=' || r.status || ' delivered_at=' || coalesce(r.delivered_at::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 6. Which ids a new message should carry
-- ---------------------------------------------------------------------------
--
-- A person is routinely a lead AND a customer. A text sent from the lead
-- page that carries only lead_id is invisible to anything reading by
-- customer_id — which includes the contact timeline on their own profile.

do $$
declare r record;
begin
  insert into public.customers (id, name, phone)
  values ('c0000000-0000-0000-0000-000000000001', 'Dana Reyes', '541-555-0101');

  select * into r from public.sms_thread_ids('a0000000-0000-0000-0000-000000000001', null);
  perform pg_temp.chk(
    'THE POINT: asked from the lead page, it finds the customer too',
    r.lead_id = 'a0000000-0000-0000-0000-000000000001'
      and r.customer_id = 'c0000000-0000-0000-0000-000000000001',
    'lead=' || coalesce(r.lead_id::text, 'null') || ' customer=' || coalesce(r.customer_id::text, 'null'));

  select * into r from public.sms_thread_ids(null, 'c0000000-0000-0000-0000-000000000001');
  perform pg_temp.chk('...and the other way round',
    r.lead_id = 'a0000000-0000-0000-0000-000000000001'
      and r.customer_id = 'c0000000-0000-0000-0000-000000000001');

  -- THE SAME PERSON, TWICE ON THE BOARD. Knocked in April, filled in the
  -- website form in June — two leads, one number, and contact_identity()
  -- returns both of them in an array whose order nobody controls.
  --
  -- The id on screen has to win. Somebody looking at the June lead and
  -- pressing send must have the message stamped with the June lead, not
  -- with whichever of the two the array happened to list first. Without
  -- this case there is only ever one lead for the number, so "prefer what
  -- you were handed" and "take the first one you find" are the same code.
  insert into public.leads (id, name, phone, status, created_at)
  values ('a0000000-0000-0000-0000-000000000002', 'Dana Reyes', '+1 541 555 0101', 'new',
          now() - interval '60 days');

  select * into r from public.sms_thread_ids('a0000000-0000-0000-0000-000000000002', null);
  perform pg_temp.chk(
    'THE POINT: with two leads on one number, the one on screen is the one stamped',
    r.lead_id = 'a0000000-0000-0000-0000-000000000002',
    'got ' || coalesce(r.lead_id::text, 'null') || ' — a message sent from one '
    'lead page would be filed against the other');

  select * into r from public.sms_thread_ids('a0000000-0000-0000-0000-000000000001', null);
  perform pg_temp.chk('...and still the other one when that is the page',
    r.lead_id = 'a0000000-0000-0000-0000-000000000001',
    'got ' || coalesce(r.lead_id::text, 'null'));

  select * into r from public.sms_thread_ids(null, null);
  perform pg_temp.chk('given nothing it invents nobody',
    r.lead_id is null and r.customer_id is null);
end $$;

do $$ begin raise notice E'\nall ok — one conversation, one human, nobody else''s\n'; end $$;
