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

-- Assertions for db/sms-app-messages.sql.
--
-- Run order: verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,
-- db/delivery-controls.sql, db/contact-history.sql, db/sms-app-messages.sql,
-- then this.
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- One thing above all others: THE SAME MESSAGE MUST NOT APPEAR TWICE. Quo
-- sends an outbound copy of everything, including the texts the CRM itself
-- sent, and this is the function that has to tell them apart. Get it wrong
-- and the customer thread shows the business saying the same sentence twice,
-- contact_attempts counts work nobody did, and the people reading it stop
-- trusting it.
--
-- There are three ways a duplicate gets in and each has its own section:
-- the sid matches, the race means there is no sid to match on yet, and Quo
-- retried the webhook.
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
-- 1. The replies that were already orphaned  (MUST BE FIRST)
-- ---------------------------------------------------------------------------
--
-- verify/sms-app-legacy.sql seeded these BEFORE the migration ran, filed the
-- way the old record_inbound_sms() filed them: message present, person
-- missing. Section 6 of db/sms-app-messages.sql is what reattached them.
--
-- FIRST IN THE FILE, and that is not cosmetic. Every section below clears the
-- tables after itself, so these rows do not survive to the end — the first
-- version of this file checked them last and failed on data its own earlier
-- sections had deleted.

do $$
declare
  n int;
begin
  perform pg_temp.chk(
    'THE POINT: a customer reply that was filed against nobody is reattached',
    (select customer_id from public.sms_messages where provider_sid = 'old_1')
      = 'aaaaaaaa-0000-0000-0000-000000000001',
    'these were sitting in the table invisible on the customer''s timeline');

  perform pg_temp.chk('...and a lead''s reply too',
    (select lead_id from public.sms_messages where provider_sid = 'old_2')
      = 'bbbbbbbb-0000-0000-0000-000000000001');

  perform pg_temp.chk('the timeline entries are reattached as well',
    (select count(*) from public.contact_log
      where phone_norm in ('15415550190', '15415550191')
        and (lead_id is not null or customer_id is not null)) = 2);

  perform pg_temp.chk(
    'THE POINT: a reply from somebody genuinely not in the CRM stays unattached',
    (select lead_id is null and customer_id is null
       from public.sms_messages where provider_sid = 'old_3'),
    'inventing a match would be worse than leaving it orphaned');

  perform pg_temp.chk(
    'THE POINT: a message that already had a home was not moved',
    (select customer_id from public.sms_messages where provider_sid = 'old_4')
      = 'aaaaaaaa-0000-0000-0000-000000000002',
    'the repair fills in nulls; it does not re-decide history');

  perform pg_temp.chk(
    'THE POINT: and one attached to the WRONG record by today''s rules is still not moved',
    (select customer_id from public.sms_messages where provider_sid = 'old_5')
      = 'aaaaaaaa-0000-0000-0000-000000000003',
    'a newer customer now owns that number, but rewriting history is not this '
    'migration''s job — the previous version would have silently moved it');

  perform pg_temp.chk(
    '...while the lead it was genuinely missing IS filled in',
    (select lead_id from public.sms_messages where provider_sid = 'old_5')
      = 'bbbbbbbb-0000-0000-0000-000000000002',
    'which is what puts the row in scope at all, and makes the check above mean something');

  -- And from here on the bug cannot recur: the inbound path uses the same key.
  perform public.record_inbound_sms('+15415550190', 'and one more thing', 'new_1');
  select count(*) into n from public.sms_messages
   where provider_sid = 'new_1' and customer_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: a NEW reply in E.164 now attaches, which is the actual fix',
    n = 1,
    'the repair cleans up the past; this is what stops it happening again');
end $$;

-- ---------------------------------------------------------------------------
-- 2. The message that used to be thrown away
-- ---------------------------------------------------------------------------

do $$
declare
  cid uuid;
  mid bigint;
  m   record;
begin
  insert into public.customers (name, phone) values ('Kathy O''Reilly', '5415550101')
  returning id into cid;

  mid := public.record_app_sms('+15415550101', 'On my way, about 20 min out', 'quo_app_1');
  perform pg_temp.chk('THE POINT: a text typed in the Quo app is kept', mid is not null,
    'this is the half of the conversation the CRM has never had');

  select * into m from public.sms_messages where id = mid;
  perform pg_temp.chk('...filed as outbound', m.direction = 'out', m.direction);
  perform pg_temp.chk('...with the words in it', m.body = 'On my way, about 20 min out');
  perform pg_temp.chk('...on the right customer''s thread', m.customer_id = cid);
  perform pg_temp.chk('...with the number normalised', m.phone = '+15415550101', m.phone);
  perform pg_temp.chk('...as a person''s message, not an automatic one', m.kind = 'manual', m.kind);
  perform pg_temp.chk('...already sent, not queued to send again', m.status = 'sent', m.status);
  perform pg_temp.chk(
    'THE POINT: with a NULL dedupe key, so two deliberate messages both survive',
    m.dedupe_key is null,
    'a person typing the same thing twice is not a bug');
  perform pg_temp.chk('...and no author invented for it', m.sent_by is null);

  perform pg_temp.chk('it reaches the contact timeline as outreach, not as a reply',
    exists (select 1 from public.contact_log
             where customer_id = cid and kind = 'text'
               and detail = 'On my way, about 20 min out'));

  perform pg_temp.chk('and it counts as having contacted them',
    (select contact_attempts from public.customers where id = cid) = 1);

  delete from public.sms_messages; delete from public.contact_log; delete from public.customers;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Duplicate way 1: the CRM sent it, and the sid matches
-- ---------------------------------------------------------------------------

do $$
declare
  cid uuid;
  n   int;
  mid bigint;
begin
  insert into public.customers (name, phone) values ('Dana', '5415550102') returning id into cid;

  -- Exactly what the CRM leaves behind: claimed, sent, sid recorded.
  insert into public.sms_messages (direction, phone, body, kind, customer_id, status, provider_sid)
  values ('out', '+15415550102', 'Here is your quote for $400', 'quote', cid, 'sent', 'quo_x1');

  mid := public.record_app_sms('+15415550102', 'Here is your quote for $400', 'quo_x1');
  perform pg_temp.chk('THE POINT: the CRM''s own message coming back is not recorded again',
    mid is null, 'the thread would show the business saying it twice');

  select count(*) into n from public.sms_messages where customer_id = cid;
  perform pg_temp.chk('...and there is still one row', n = 1, n::text);

  perform pg_temp.chk('...and no contact attempt was counted for it',
    coalesce((select contact_attempts from public.customers where id = cid), 0) = 0);

  -- A DIFFERENT message to the same person, same minute, still gets through.
  mid := public.record_app_sms('+15415550102', 'Also, gate code is 4471', 'quo_x2');
  perform pg_temp.chk('a genuinely different message in the same minute is kept',
    mid is not null);

  -- THE SID ON ITS OWN, with the echo window long past.
  --
  -- Every duplicate above is caught by BOTH the sid and the words-in-a-window
  -- check, so deleting the sid check changed nothing and the suite stayed
  -- green. A webhook that arrives late — Quo retrying after an outage — has
  -- only the sid left to match on.
  update public.sms_messages set created_at = now() - interval '2 hours'
   where provider_sid = 'quo_x1';
  mid := public.record_app_sms('+15415550102', 'Here is your quote for $400', 'quo_x1');
  perform pg_temp.chk(
    'THE POINT: a copy arriving hours late is still recognised by its id alone',
    mid is null,
    'the echo window has long closed; the sid is the only thing left');

  delete from public.sms_messages; delete from public.contact_log; delete from public.customers;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Duplicate way 2: the race, where there is no sid to match on
-- ---------------------------------------------------------------------------
--
-- postToQuo() has returned but mark_sms_sent() has not written the sid yet,
-- and Quo's copy is already at the door. The only thing the two rows have in
-- common is the words.

do $$
declare
  cid uuid;
  mid bigint;
  n   int;
begin
  insert into public.customers (name, phone) values ('Rob', '5415550103') returning id into cid;

  -- Claimed, not yet marked sent: provider_sid is still null.
  insert into public.sms_messages (direction, phone, body, kind, customer_id, status)
  values ('out', '+15415550103', 'See you Thursday at 9', 'reminder', cid, 'queued');

  mid := public.record_app_sms('+15415550103', 'See you Thursday at 9', 'quo_y1');
  perform pg_temp.chk(
    'THE POINT: an echo arriving before the sid is written is still recognised',
    mid is null,
    'provider_sid is null on our row, so the words are the only thing to match on');

  select count(*) into n from public.sms_messages where customer_id = cid;
  perform pg_temp.chk('...still one row', n = 1, n::text);

  -- Outside the window it is a new message, which is the whole point of the
  -- window being short: somebody really can send the same sentence twice.
  update public.sms_messages set created_at = now() - interval '10 minutes'
   where customer_id = cid;
  mid := public.record_app_sms('+15415550103', 'See you Thursday at 9', 'quo_y2');
  perform pg_temp.chk('the same words ten minutes later are a new message', mid is not null);

  -- And an INBOUND message with the same words is never mistaken for our echo.
  delete from public.sms_messages;
  insert into public.sms_messages (direction, phone, body, kind, customer_id, status)
  values ('in', '+15415550103', 'Sounds good', 'inbound', cid, 'received');
  mid := public.record_app_sms('+15415550103', 'Sounds good', 'quo_y3');
  perform pg_temp.chk(
    'THE POINT: repeating what the customer said is still our own message',
    mid is not null,
    'the echo check must look at outbound rows only');

  delete from public.sms_messages; delete from public.contact_log; delete from public.customers;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Duplicate way 3: Quo retried the webhook
-- ---------------------------------------------------------------------------

do $$
declare
  cid uuid;
  a   bigint;
  b   bigint;
  n   int;
begin
  insert into public.customers (name, phone) values ('Tim', '5415550104') returning id into cid;

  a := public.record_app_sms('+15415550104', 'Running late, sorry', 'quo_z1');
  b := public.record_app_sms('+15415550104', 'Running late, sorry', 'quo_z1');

  perform pg_temp.chk('the first copy is kept', a is not null);
  perform pg_temp.chk('THE POINT: a retried webhook does not add a second row', b is null);

  select count(*) into n from public.sms_messages where customer_id = cid;
  perform pg_temp.chk('...one row', n = 1, n::text);
  perform pg_temp.chk('...and one contact attempt, not two',
    (select contact_attempts from public.customers where id = cid) = 1);

  -- The index is what makes that true under concurrency, not the check.
  perform pg_temp.chk('THE POINT: provider_sid is unique at the table level',
    exists (select 1 from pg_class where relname = 'sms_messages_sid_idx'),
    'two webhooks racing both pass the existence check; only the index stops them');

  delete from public.sms_messages; delete from public.contact_log; delete from public.customers;
end $$;

-- ---------------------------------------------------------------------------
-- 6. What it refuses outright
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.chk('a message with no usable number is dropped',
    public.record_app_sms('ring the doorbell', 'hello', 'q1') is null);
  perform pg_temp.chk('an empty message is dropped',
    public.record_app_sms('5415550199', '   ', 'q2') is null);
  perform pg_temp.chk('a null message is dropped',
    public.record_app_sms('5415550199', null, 'q3') is null);
end $$;

-- ---------------------------------------------------------------------------
-- 7. A number nobody in the CRM owns
-- ---------------------------------------------------------------------------

do $$
declare
  mid bigint;
  m   record;
begin
  mid := public.record_app_sms('5415550177', 'Hi, this is Sky Blue', 'quo_w1');
  perform pg_temp.chk('a text to a stranger is still kept', mid is not null,
    'texting somebody before they are in the CRM is normal');

  select * into m from public.sms_messages where id = mid;
  perform pg_temp.chk('...with no lead and no customer attached',
    m.lead_id is null and m.customer_id is null);

  delete from public.sms_messages; delete from public.contact_log;
end $$;

-- ---------------------------------------------------------------------------
-- 8. The duplicated lookup, held together
-- ---------------------------------------------------------------------------
--
-- record_inbound_sms() has its own copy of "whose number is this". Replacing
-- it would mean redefining a db/sms.sql function in another file and leaving
-- two definitions in the repo. So instead: run both against the same numbers
-- and fail the moment they disagree.

do $$
declare
  l1  uuid; l2 uuid; c1 uuid;
  who record;
  inb bigint;
  m   record;
begin
  -- The awkward shape contact_identity exists for: one human, several rows,
  -- the number written differently each time.
  --
  -- created_at is set EXPLICITLY. The first version used pg_sleep between the
  -- inserts, which does nothing here: now() is fixed for the whole
  -- transaction, so both rows landed on the same timestamp, the ordering was
  -- a coin toss, and the test failed about half the time for a reason that
  -- had nothing to do with the code under test.
  insert into public.leads (name, phone, created_at)
  values ('Old lead', '(541) 555-0150', now() - interval '30 days') returning id into l1;
  insert into public.leads (name, phone, created_at)
  values ('Newer lead', '541-555-0150', now() - interval '1 day') returning id into l2;
  insert into public.customers (name, phone) values ('Same person', '5415550150') returning id into c1;

  who := public.sb_contact_for_phone('5415550150');
  perform pg_temp.chk('the newest lead wins, not the oldest', who.lead_id = l2);
  perform pg_temp.chk('and the customer is found too', who.customer_id = c1);

  -- Now the inbound path, which has its own copy of that logic.
  inb := public.record_inbound_sms('5415550150', 'hello?', 'quo_in_1');
  select * into m from public.sms_messages where id = inb;

  perform pg_temp.chk(
    'THE POINT: the inbound path and sb_contact_for_phone agree on the lead',
    m.lead_id = who.lead_id,
    'two copies of this lookup exist; the day they disagree a reply lands on the wrong record');
  perform pg_temp.chk('...and on the customer', m.customer_id = who.customer_id);

  perform pg_temp.chk('formatting does not change the answer',
    (public.sb_contact_for_phone('(541) 555-0150')).lead_id = l2);

  -- BOTH DIRECTIONS, which is the whole bug. Every other test here stores a
  -- ten-digit number, and against those the old sb_phone_digits() matching
  -- looks identical — it only breaks when the two sides are written
  -- differently. Mutation testing found this: reverting the customer lookup
  -- to sb_phone_digits() left every assertion passing.
  declare
    e_cust uuid;
  begin
    insert into public.customers (name, phone) values ('Stored in E.164', '+15415550151')
    returning id into e_cust;

    perform pg_temp.chk(
      'THE POINT: a number stored as +1 is found when the message says 10 digits',
      (public.sb_contact_for_phone('5415550151')).customer_id = e_cust,
      'sb_phone_digits leaves the leading 1 on, so these never compared equal');

    perform pg_temp.chk('...and found when the message says +1 too',
      (public.sb_contact_for_phone('+15415550151')).customer_id = e_cust);

    perform pg_temp.chk(
      'THE POINT: a reply in E.164 attaches to a lead stored without it',
      (public.sb_contact_for_phone('+15415550150')).lead_id = l2,
      'this is the exact shape Quo sends and the CRM stores');
  end;
  perform pg_temp.chk('a number nobody has returns nothing',
    (public.sb_contact_for_phone('5415559999')).lead_id is null);

  delete from public.sms_messages; delete from public.contact_log;
  delete from public.customers; delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 9. The thread itself
-- ---------------------------------------------------------------------------
--
-- The point of all of this: one query, in order, both sides.

do $$
declare
  cid uuid;
  thread text;
begin
  insert into public.customers (name, phone) values ('Jeff', '5415550160') returning id into cid;

  insert into public.sms_messages (direction, phone, body, kind, customer_id, status, created_at)
  values ('out', '+15415550160', 'Here is your quote for $1,180', 'quote', cid, 'sent', now() - interval '3 hours');
  perform public.record_inbound_sms('5415550160', 'Looks good, can you do Friday?', 'quo_t2');
  perform public.record_app_sms('+15415550160', 'Friday works, see you at 9', 'quo_t3');

  select string_agg(
           case when direction = 'in' then '<- ' else '-> ' end || body,
           ' | ' order by created_at, id)
    into thread
  from public.sms_messages where customer_id = cid;

  perform pg_temp.chk(
    'THE POINT: one query returns the whole conversation, both sides, in order',
    thread = '-> Here is your quote for $1,180 | <- Looks good, can you do Friday? | -> Friday works, see you at 9',
    coalesce(thread, '(empty)'));

  delete from public.sms_messages; delete from public.contact_log; delete from public.customers;
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — the CRM now holds both halves of the conversation';
end $$;
