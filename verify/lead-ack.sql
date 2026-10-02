-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it.
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
      'runs against a scratch database built by verify/sms-fixture.sql, '
      'which creates public._scratch_db. If you meant to apply a migration, '
      'the file you want is in db/.';
  end if;
end $$;

-- Assertions for db/lead-ack.sql.
--
-- Run against a THROWAWAY Postgres, after verify/sms-fixture.sql, db/sms.sql,
-- db/sms-delivery.sql, db/email-delivery.sql and db/lead-ack.sql.
--
-- What this is actually checking
-- ------------------------------
-- Two things above all others.
--
-- NOBODY IS ACKNOWLEDGED TWICE. This message says "we'll contact you
-- shortly". A second copy says the business is automated and not listening,
-- which is worse than never having sent the first. The sweep runs every
-- minute, so a lead is looked at roughly 1,440 times a day and must be
-- answered on exactly one of them.
--
-- NOBODY IS ACKNOWLEDGED WHO DID NOT ASK. A lead Hayden types in at
-- somebody's door must never get "thanks for reaching out" — he is standing
-- in front of them.

do $$
declare
  web_id   uuid;
  door_id  uuid;
  old_id   uuid;
  fresh_id uuid;
  mail_id  uuid;
  n        int;
  s        text;
  b        boolean;
  dup_lead uuid;
  dup_quote uuid;
begin
  -- A website enquiry, two minutes old, with a phone number.
  insert into public.leads (name, phone, email, address, status, source, created_at)
  values ('Web Wanda', '+15555550011', 'wanda@example.com', '2 Web St',
          'new', 'website', now() - interval '2 minutes')
  returning id into web_id;

  -- =========================================================================
  -- The timer
  -- =========================================================================

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = web_id;
  assert n = 1, format('a two-minute-old web enquiry should be due, got %s', n);
  raise notice 'ok    a web enquiry past the delay is due an acknowledgment';

  -- Ten seconds old: NOT yet. An instant reply reads as a robot, which is
  -- the entire reason the delay exists.
  insert into public.leads (name, phone, address, status, source, created_at)
  values ('Fresh Fred', '+15555550012', '3 New St', 'new', 'website',
          now() - interval '10 seconds')
  returning id into fresh_id;

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = fresh_id;
  assert n = 0,
    format('THE POINT: an enquiry inside the delay must not be answered yet, got %s', n);
  raise notice 'ok    THE POINT: one that just arrived waits for the timer';

  -- Eight hours old: too late to be an acknowledgment at all.
  insert into public.leads (name, phone, address, status, source, created_at)
  values ('Stale Stan', '+15555550013', '4 Old St', 'new', 'website',
          now() - interval '8 hours')
  returning id into old_id;

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = old_id;
  assert n = 0,
    format('THE POINT: a stale enquiry must not be answered, got %s', n);
  raise notice 'ok    THE POINT: and one from this morning is left alone';

  -- =========================================================================
  -- Who asked, and who did not
  -- =========================================================================

  insert into public.leads (name, phone, address, status, source, created_at)
  values ('Door Dora', '+15555550014', '5 Door St', 'contacted', 'door',
          now() - interval '2 minutes')
  returning id into door_id;

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = door_id;
  assert n = 0,
    format('THE POINT: a door knock must not be acknowledged, got %s', n);
  raise notice 'ok    THE POINT: a lead knocked at the door is not acknowledged';

  -- A website lead somebody typed in by hand is also not a web enquiry: the
  -- created_by is what tells them apart.
  update public.leads set created_by = (select id from public.profiles limit 1)
   where id = web_id;
  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = web_id;
  assert n = 0,
    format('a web-sourced lead a person created is not a web enquiry, got %s', n);
  raise notice 'ok    nor one a person typed in and marked as website';
  update public.leads set created_by = null where id = web_id;

  -- =========================================================================
  -- Never twice
  -- =========================================================================

  select out_has_sms into b from public.sms_due_lead_acks(50) where out_lead_id = web_id;
  assert b, 'a lead with a good number should be textable';
  raise notice 'ok    a reachable enquiry is offered by text';

  perform public.claim_sms('ack', '+15555550011', 'Thanks for reaching out.',
                           web_id, null, null, null, null, true);

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = web_id;
  assert n = 0,
    format('THE POINT: an acknowledged lead must not come back, got %s', n);
  raise notice 'ok    THE POINT: once acknowledged it is never offered again';

  -- The dedupe index is what makes two overlapping sweeps safe. The query
  -- above is a filter; this is a constraint.
  select ok into b from public.claim_sms('ack', '+15555550011', 'Thanks again.',
                                         web_id, null, null, null, null, true);
  assert not b,
    'THE POINT: a second claim for the same lead must be refused by the index';
  raise notice 'ok    THE POINT: and two sweeps racing produce one message';

  select count(*) into n from public.sms_messages
   where lead_id = web_id and kind = 'ack';
  assert n = 1, format('exactly one ack row should exist, got %s', n);
  raise notice 'ok    exactly one row, however many runs looked at it';

  -- Even if the carrier refuses it. An acknowledgment retried days later is
  -- not an acknowledgment, and the dedupe index alone would allow it because
  -- an undelivered row leaves the index.
  update public.sms_messages set status = 'undelivered'
   where lead_id = web_id and kind = 'ack';
  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = web_id;
  assert n = 0,
    format('THE POINT: an undelivered ack must not be retried later, got %s', n);
  raise notice 'ok    THE POINT: and an undelivered one is not retried days later';

  -- =========================================================================
  -- A human got there first
  -- =========================================================================

  insert into public.leads (name, phone, address, status, source, created_at)
  values ('Quick Quentin', '+15555550015', '6 Fast St', 'new', 'website',
          now() - interval '3 minutes')
  returning id into mail_id;

  perform public.claim_sms('manual', '+15555550015', 'Hi, saw your message — can I call you?',
                           mail_id, null, null, null, null, true);

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = mail_id;
  assert n = 0,
    format('THE POINT: someone already texted them, got %s', n);
  raise notice 'ok    THE POINT: a lead a person already texted gets no robot reply';

  -- =========================================================================
  -- Email only
  -- =========================================================================

  insert into public.leads (name, email, address, status, source, created_at)
  values ('Emailing Ellie', 'ellie@example.com', '7 Mail St', 'new', 'website',
          now() - interval '2 minutes')
  returning id into mail_id;

  select out_has_sms, out_email into b, s
  from public.sms_due_lead_acks(50) where out_lead_id = mail_id;
  assert not b, 'an enquiry with no phone is not textable';
  assert s = 'ellie@example.com', format('but its email should come back, got %s', s);
  raise notice 'ok    an enquiry with only an email is offered by email';

  insert into public.sent_emails (kind, to_email, subject, lead_id, status)
  values ('ack', 'ellie@example.com', 'Thanks for reaching out', mail_id, 'sent');

  select count(*) into n from public.sms_due_lead_acks(50) x where x.out_lead_id = mail_id;
  assert n = 0,
    format('THE POINT: an emailed acknowledgment also counts, got %s', n);
  raise notice 'ok    THE POINT: and an emailed one counts as answered too';

  -- =========================================================================
  -- Unreachable
  -- =========================================================================

  insert into public.leads (name, address, status, source, created_at)
  values ('Nameless Nora', '8 Nowhere St', 'new', 'website', now() - interval '2 minutes');

  select count(*) into n
  from public.sms_due_lead_acks(50) x
  join public.leads l on l.id = x.out_lead_id
  where l.name = 'Nameless Nora';
  assert n = 0, format('an enquiry with no phone and no email is not offered, got %s', n);
  raise notice 'ok    one with no way to reach them is skipped rather than failing';

  -- An opted-out number is offered, but not by text — so it falls to email
  -- rather than disappearing.
  insert into public.leads (name, phone, email, address, status, source, created_at)
  values ('Stopped Steve', '+15555550016', 'steve@example.com', '9 Stop St',
          'new', 'website', now() - interval '2 minutes');
  insert into public.sms_opt_outs (phone) values ('+15555550016')
    on conflict do nothing;

  select out_has_sms into b
  from public.sms_due_lead_acks(50) x
  join public.leads l on l.id = x.out_lead_id
  where l.name = 'Stopped Steve';
  assert not b,
    'THE POINT: an opted-out number must not be texted, even an acknowledgment';
  raise notice 'ok    THE POINT: an opted-out number is never texted, force or not';

  -- =========================================================================
  -- The rebuilt index still protects everything it protected before
  -- =========================================================================
  --
  -- This file DROPS AND RE-ADDS the dedupe_key column to teach it about
  -- acks, and the unique index goes with it. The first draft put the index
  -- back with db/sms.sql's two-status predicate instead of the three-status
  -- one db/sms-delivery.sql widened it to — and ON CONFLICT with no matching
  -- index raises outright, so every text the CRM sent would have failed,
  -- quotes included.
  --
  -- These assert the OTHER kinds still dedupe, because an ack feature that
  -- quietly lets a customer be quoted twice is not a feature.

  insert into public.leads (name, phone, address, status, source)
  values ('Dup Dave', '+15555550099', '1 Dup St', 'quoted', 'door')
  returning id into dup_lead;

  insert into public.quotes (lead_id, customer_name, amount, status, token)
  values (dup_lead, 'Dup Dave', 500, 'sent', 'tok_dup')
  returning id into dup_quote;

  select ok into b from public.claim_sms('quote', '+15555550099', 'First',
                                         dup_lead, null, dup_quote, null, null, true);
  assert b, 'the first quote text should be claimed';

  select ok into b from public.claim_sms('quote', '+15555550099', 'Second',
                                         dup_lead, null, dup_quote, null, null, true);
  assert not b,
    'THE POINT: the rebuilt index must still stop a customer being quoted twice';
  raise notice 'ok    THE POINT: the rebuilt index still dedupes quote texts';

  -- And an undelivered one still holds the slot, which is what the
  -- three-status predicate is for.
  update public.sms_messages set status = 'undelivered'
   where quote_id = dup_quote and kind = 'quote';
  select ok into b from public.claim_sms('quote', '+15555550099', 'Third',
                                         dup_lead, null, dup_quote, null, null, true);
  assert not b,
    'THE POINT: an undelivered quote text must still hold its dedupe slot';
  raise notice 'ok    THE POINT: and an undelivered one still holds its slot';

  raise notice '--- all assertions passed ---';
end $$;
