-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it. Without it the guard raises, psql
-- shrugs, and the DELETEs below run anyway — which is the entire failure
-- this is meant to prevent. In the Supabase SQL editor the RAISE aborts the
-- surrounding transaction on its own, so nothing after it commits there.
\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE DELETES ROWS. It is for a THROWAWAY Postgres, never for      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it deletes rows. It only '
      'runs against a scratch database built by the matching '
      'verify/*-fixture.sql, which creates public._scratch_db. If you meant '
      'to apply a migration, the file you want is in db/.';
  end if;
end $$;

-- Assertions for db/email-delivery.sql and db/quote-sender-name.sql.
--
--   psql -d scratch -f verify/sms-fixture.sql
--   psql -d scratch -f db/sms.sql
--   psql -d scratch -f db/sms-delivery.sql
--   psql -d scratch -f db/quote-sender-name.sql
--   psql -d scratch -f db/email-delivery.sql
--   psql -d scratch -f verify/email-delivery.sql
--
-- What this is actually checking
-- ------------------------------
-- Two things that fail silently, which is why they are worth a test at all:
--
--   1. A bounce must suppress a DEAD address and must NOT suppress a
--      temporarily unhappy one. Getting the first wrong means the failures
--      list fills with one address repeated nightly until the real problems
--      underneath are invisible. Getting the second wrong means a paying
--      customer quietly stops receiving email from the business, forever,
--      and nothing anywhere says so.
--
--   2. A quote must sign itself with whoever sent it. The old behaviour —
--      every message saying "Jordan" — produced no error, no warning and a
--      perfectly deliverable text. It was only wrong.

\set ON_ERROR_STOP on
\pset pager off

create or replace function chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then
    raise notice 'ok    %', what;
  else
    raise notice 'FAIL  %  %', what, coalesce(detail, '');
    update _score set failed = failed + 1;
  end if;
end $$;

create table if not exists _score (failed int not null default 0);
delete from _score;
insert into _score values (0);

-- ---------------------------------------------------------------------------
-- Which bounces are permanent
-- ---------------------------------------------------------------------------

select chk('a hard bounce is permanent',
           public.sb_email_permanent('Permanent: mailbox does not exist'));
select chk('"no such user" is permanent',
           public.sb_email_permanent('550 5.1.1 no such user here'));
select chk('an invalid recipient is permanent',
           public.sb_email_permanent('Invalid recipient address'));
select chk('a suppressed address is permanent',
           public.sb_email_permanent('Suppressed: on the account suppression list'));

-- THE POINT, pointed the other way. A full mailbox is emptied on Monday and
-- a greylisted message is accepted on the retry. Writing either of them off
-- loses a real customer in a way nothing reports.
select chk('THE POINT: a full mailbox is NOT permanent',
           not public.sb_email_permanent('552 mailbox full, try again later'));
select chk('THE POINT: greylisting is NOT permanent',
           not public.sb_email_permanent('451 4.7.1 greylisted, please retry'));
select chk('THE POINT: a temporary deferral is NOT permanent',
           not public.sb_email_permanent('Transient: deferred by the receiving server'));

-- The reason a bare '550' is not matched. An error string that quotes the
-- message back at us can easily contain a dollar amount.
select chk('THE POINT: a $550 quote in the error text is NOT permanent',
           not public.sb_email_permanent('Rejected message: Your quote for $550 - screens included'));

select chk('an unknown reason is NOT permanent',
           not public.sb_email_permanent('something nobody has seen before'));
select chk('no reason at all is NOT permanent',
           not public.sb_email_permanent(null));

-- ---------------------------------------------------------------------------
-- Addresses are one address however they are typed
-- ---------------------------------------------------------------------------

select chk('addresses normalise to lower case',
           public.sb_email_norm('  Judy@Example.COM ') = 'judy@example.com');
select chk('an empty address normalises to null',
           public.sb_email_norm('   ') is null);

-- ---------------------------------------------------------------------------
-- A quote email that bounces permanently
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead  uuid;
  v_quote uuid;
  v_id    uuid;
  r       record;
  n       int;
begin
  -- Self-cleaning, so the file can be run twice against the same scratch
  -- database without the second run tripping over the first one's rows.
  delete from public.email_unreachable
   where email in ('judy@example.com', 'sam@example.com', 'pat@example.com');
  delete from public.sent_emails
   where to_email in ('judy@example.com', 'sam@example.com', 'pat@example.com');
  delete from public.quotes where customer_name = 'Judy Email Test';
  delete from public.leads  where name = 'Judy Email Test';

  insert into public.leads (name, phone, email)
  values ('Judy Email Test', '+15415550101', 'Judy@Example.com')
  returning id into v_lead;

  insert into public.quotes (token, lead_id, customer_name, amount, status, sent_at, sent_by)
  values ('tok-email-1', v_lead, 'Judy Email Test', 449, 'sent', now(),
          '22222222-2222-2222-2222-222222222222')
  returning id into v_quote;

  v_id := public.record_email_sent(
    p_kind => 'quote',
    p_to   => 'Judy@Example.com',
    p_subject => 'Your Sky Blue Cleaning quote — $449',
    p_provider_id => 'resend-aaa',
    p_lead_id => v_lead,
    p_quote_id => v_quote
  );

  perform chk('a send is recorded', v_id is not null);

  select * into r from public.sent_emails where id = v_id;
  perform chk('the address is stored normalised', r.to_email = 'judy@example.com');
  perform chk('a new send starts as sent', r.status = 'sent');

  -- A Netlify function that is retried after it already sent must not
  -- produce a second record of one email.
  perform public.record_email_sent(
    p_kind => 'quote', p_to => 'judy@example.com', p_provider_id => 'resend-aaa'
  );
  select count(*) into n from public.sent_emails where provider_id = 'resend-aaa';
  perform chk('THE POINT: a repeated send is not recorded twice', n = 1, n::text);

  -- The bounce arrives.
  select * into r from public.mark_email_failed(
    'resend-aaa', 'judy@example.com', 'bounced',
    'Permanent: mailbox does not exist'
  );

  perform chk('the bounce comes back to the caller', r.out_id = v_id);
  perform chk('the bounce knows which quote it was', r.out_quote_id = v_quote);
  perform chk('the bounce knows it is permanent', r.out_permanent);

  select * into r from public.sent_emails where id = v_id;
  perform chk('the row is marked bounced', r.status = 'bounced');

  -- THE POINT. Without this the nightly follow-up run emails this address
  -- again tonight, and tomorrow night, and the failures list becomes forty
  -- copies of one problem.
  perform chk('THE POINT: a permanent bounce closes the address',
              public.sb_email_unreachable('judy@example.com'));
  perform chk('and closes it however it is typed',
              public.sb_email_unreachable('JUDY@example.com'));

  -- Resend retries webhooks. The second delivery must do nothing, or the
  -- office is told twice about one bounce — and a notification that cries
  -- wolf is a notification that gets muted.
  select count(*) into n from public.mark_email_failed(
    'resend-aaa', 'judy@example.com', 'bounced', 'Permanent: mailbox does not exist'
  );
  perform chk('THE POINT: a retried webhook reports nothing', n = 0, n::text);

  select failures into n from public.email_unreachable where email = 'judy@example.com';
  perform chk('and does not double-count the refusal', n = 1, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- A bounce that is nobody's fault
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
  r    record;
begin
  v_id := public.record_email_sent(
    p_kind => 'follow_up', p_to => 'sam@example.com', p_provider_id => 'resend-bbb'
  );

  select * into r from public.mark_email_failed(
    'resend-bbb', 'sam@example.com', 'bounced', '552 mailbox full, try again later'
  );

  perform chk('a soft bounce is still recorded', r.out_id = v_id);
  perform chk('a soft bounce is not permanent', not r.out_permanent);

  -- THE POINT. This is the failure that costs a customer: their mailbox was
  -- full for an afternoon and the business never emails them again.
  perform chk('THE POINT: a full mailbox does NOT close the address',
              not public.sb_email_unreachable('sam@example.com'));
end $$;

-- ---------------------------------------------------------------------------
-- A spam complaint
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  perform public.record_email_sent(
    p_kind => 'follow_up', p_to => 'pat@example.com', p_provider_id => 'resend-ccc'
  );

  -- No error string at all, which is what Resend actually sends for a
  -- complaint. The verdict cannot come from the wording here; it has to come
  -- from the event type.
  select * into r from public.mark_email_failed(
    'resend-ccc', 'pat@example.com', 'complained', null
  );

  perform chk('THE POINT: a complaint is permanent with no error text at all',
              r.out_permanent);
  perform chk('a complaint closes the address',
              public.sb_email_unreachable('pat@example.com'));
  perform chk('and is recorded as a complaint, not a bounce',
              (select complained from public.email_unreachable
                where email = 'pat@example.com'));
end $$;

-- ---------------------------------------------------------------------------
-- An event for an email we have no record of
-- ---------------------------------------------------------------------------
--
-- Sent before this migration existed, or sent by something else entirely.
-- Dropping it would mean a customer who was never reached stays invisible,
-- which is the one thing this whole file exists to prevent.

do $$
declare
  r record;
  n int;
begin
  delete from public.email_unreachable where email = 'ghost@example.com';
  delete from public.sent_emails where to_email = 'ghost@example.com';

  select * into r from public.mark_email_failed(
    'resend-never-seen', 'ghost@example.com', 'bounced', '550 no such user'
  );

  perform chk('THE POINT: an unknown bounce is still recorded', r.out_id is not null);
  perform chk('and is marked as unknown rather than guessed at',
              r.out_kind = 'unknown');

  select count(*) into n from public.sent_emails where to_email = 'ghost@example.com';
  perform chk('exactly one row is created for it', n = 1, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- Letting an address back in
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  perform chk('a closed address is closed before clearing',
              public.sb_email_unreachable('judy@example.com'));

  perform public.clear_email_unreachable(
    'judy@example.com', '11111111-1111-1111-1111-111111111111'
  );

  perform chk('clearing reopens it',
              not public.sb_email_unreachable('judy@example.com'));
  perform chk('and records who did it',
              (select cleared_by from public.email_unreachable
                where email = 'judy@example.com')
              = '11111111-1111-1111-1111-111111111111');

  -- Refused again after being reopened by hand: it must close again. A
  -- cleared_at that survives the next bounce means the address is emailed
  -- every night forever.
  perform public.record_email_sent(
    p_kind => 'quote', p_to => 'judy@example.com', p_provider_id => 'resend-ddd'
  );
  perform public.mark_email_failed(
    'resend-ddd', 'judy@example.com', 'bounced', 'Permanent: mailbox does not exist'
  );

  perform chk('THE POINT: refused again after reopening, it closes again',
              public.sb_email_unreachable('judy@example.com'));

  select failures into n from public.email_unreachable where email = 'judy@example.com';
  perform chk('and the refusals are counted', n = 2, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- Delivered
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
begin
  delete from public.sent_emails where provider_id = 'resend-eee';
  v_id := public.record_email_sent(
    p_kind => 'quote', p_to => 'ok@example.com', p_provider_id => 'resend-eee'
  );

  perform public.mark_email_delivered('resend-eee');
  perform chk('a delivered email stops saying sent',
              (select status from public.sent_emails where id = v_id) = 'delivered');

  -- Delivered is not a failure and must not appear on the failures screen.
  perform chk('THE POINT: a delivered email is not in the failures list',
              not exists (select 1 from public.delivery_failures
                           where provider_ref = 'resend-eee'));
end $$;

-- ---------------------------------------------------------------------------
-- The day-before confirmation, by email
-- ---------------------------------------------------------------------------

do $$
declare
  v_cust uuid;
  v_job  uuid;
  v_gone uuid;
  v_past uuid;
  n      int;
  r      record;
begin
  delete from public.jobs where id in (
    select j.id from public.jobs j
     join public.customers c on c.id = j.customer_id
    where c.name in ('Trish Reminder Test', 'Chris No Email Test')
  );
  delete from public.customers
   where name in ('Trish Reminder Test', 'Chris No Email Test');

  insert into public.customers (name, phone, email, address)
  values ('Trish Reminder Test', '+15415550202', 'trish@example.com', '14 Oak St')
  returning id into v_cust;

  -- FIVE days out, not one, and that is not arbitrary.
  --
  -- reminder_for_email() only asks whether the job is still ahead of us, so
  -- any future date exercises it identically. sms_due_job_reminders() in
  -- verify/sms.sql counts the jobs happening TOMORROW — so a fixture here
  -- dated tomorrow makes that suite fail, but only when the two are run
  -- against the same scratch database in this order. That is a failure that
  -- looks like a real regression and costs an afternoon.
  insert into public.jobs (customer_id, status, starts_at, services)
  values (v_cust, 'scheduled', now() + interval '5 days', 'Exterior windows')
  returning id into v_job;

  select * into r from public.reminder_for_email(v_job);
  perform chk('a scheduled job has a second route', r.out_email = 'trish@example.com');
  perform chk('and it carries the time', r.out_starts_at is not null);
  perform chk('and the address', r.out_address = '14 Oak St');

  -- THE POINT. A late-arriving webhook must not confirm a job that has been
  -- cancelled. "We're coming tomorrow" sent to somebody who cancelled on
  -- Tuesday is worse than saying nothing at all.
  update public.jobs set status = 'cancelled' where id = v_job;
  select count(*) into n from public.reminder_for_email(v_job);
  perform chk('THE POINT: a cancelled job is never confirmed by email', n = 0, n::text);

  -- And nor is one that has already happened.
  update public.jobs set status = 'scheduled', starts_at = now() - interval '2 days'
   where id = v_job;
  select count(*) into n from public.reminder_for_email(v_job);
  perform chk('THE POINT: a job in the past is never confirmed', n = 0, n::text);

  update public.jobs set starts_at = now() + interval '5 days' where id = v_job;

  -- No email on file: no second route, and the caller has to be told that
  -- plainly rather than handed a row with a null address in it.
  insert into public.customers (name, phone, address)
  values ('Chris No Email Test', '+15415550303', '9 Elm St')
  returning id into v_gone;

  insert into public.jobs (customer_id, status, starts_at)
  values (v_gone, 'scheduled', now() + interval '5 days')
  returning id into v_past;

  select count(*) into n from public.reminder_for_email(v_past);
  perform chk('a customer with no email has no second route', n = 0, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- One list, both channels
-- ---------------------------------------------------------------------------

do $$
declare
  v_cust uuid;
  v_job  uuid;
  n      int;
  r      record;
begin
  select id into v_cust from public.customers where name = 'Trish Reminder Test';
  select id into v_job  from public.jobs where customer_id = v_cust limit 1;

  delete from public.sms_messages where phone = '+15415550202';

  insert into public.sms_messages
    (direction, kind, phone, body, status, customer_id, job_id, error, provider_sid)
  values
    ('out', 'reminder', '+15415550202',
     'Hi Trish, Sky Blue Cleaning here - we''re scheduled for tomorrow',
     'undelivered', v_cust, v_job, 'destination not found', 'quo-zzz');

  select count(*) into n from public.delivery_failures where channel = 'text';
  perform chk('texts appear in the combined list', n > 0, n::text);

  select count(*) into n from public.delivery_failures where channel = 'email';
  perform chk('emails appear in the combined list', n > 0, n::text);

  -- THE POINT of the whole feature for Jordan: a failed day-before
  -- confirmation has to be findable, and it has to carry the job's time, or
  -- "call them today" means going and looking up which job it was about.
  select * into r from public.delivery_failures
   where channel = 'text' and kind = 'reminder' and provider_ref = 'quo-zzz';
  perform chk('THE POINT: a failed reminder is in the list', r.id is not null);
  perform chk('THE POINT: and carries the job it was about', r.job_id = v_job);
  perform chk('THE POINT: and the time that job starts', r.job_at is not null);
  perform chk('and the name to call', r.who = 'Trish Reminder Test');
  perform chk('and a number to call it on', r.phone = '+15415550202');
  perform chk('and the address to fall back to', r.email = 'trish@example.com');
end $$;

-- ---------------------------------------------------------------------------
-- The name on the quote
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead uuid;
  v_q    uuid;
  r      record;
begin
  delete from public.quotes where token in ('tok-sender-1', 'tok-sender-2');
  delete from public.leads where name = 'Sender Name Test';

  insert into public.leads (name, phone, email)
  values ('Sender Name Test', '+15415550404', 'sender@example.com')
  returning id into v_lead;

  -- Sent by Hayden, not Jordan.
  insert into public.quotes
    (token, lead_id, customer_name, amount, status, sent_at, sent_by)
  values ('tok-sender-1', v_lead, 'Sender Name Test', 300, 'sent',
          now() - interval '10 days',
          '22222222-2222-2222-2222-222222222222')
  returning id into v_q;

  select * into r from public.quote_for_email(v_q);
  -- THE POINT. The old templates said "Jordan" in the source. A quote Hayden
  -- sent that introduces him as Jordan sends the customer's reply to the
  -- wrong brother, and nothing anywhere errors.
  perform chk('THE POINT: the email fallback knows who sent the quote',
              r.out_sender_name = 'Hayden Mortensen', coalesce(r.out_sender_name, '(null)'));

  select * into r from public.sms_due_quote_nudges(25)
   where quote_id = v_q;
  perform chk('THE POINT: the nightly nudge knows who sent the quote',
              r.sender_name = 'Hayden Mortensen', coalesce(r.sender_name, '(null)'));

  -- A quote whose sender has left must still be chased. Signing as the
  -- company is fine; not following it up at all is not.
  update public.quotes set sent_by = null where id = v_q;
  select count(*) into r from public.sms_due_quote_nudges(25) where quote_id = v_q;
  perform chk('THE POINT: a quote with no sender is still chased',
              r.count = 1, r.count::text);
end $$;

-- ---------------------------------------------------------------------------
-- A carrier rejection still stops a nudge being rebuilt
-- ---------------------------------------------------------------------------
--
-- db/quote-sender-name.sql rewrites sms_due_quote_nudges(). The one thing
-- that must not change in the rewrite is the guard that stops a refused
-- number being queued again every night.

do $$
declare
  v_lead uuid;
  v_q    uuid;
  n      int;
begin
  delete from public.quotes where token = 'tok-nudge-guard';
  delete from public.leads where name = 'Nudge Guard Test';

  insert into public.leads (name, phone)
  values ('Nudge Guard Test', '+15415550505')
  returning id into v_lead;

  insert into public.quotes
    (token, lead_id, customer_name, amount, status, sent_at, sent_by)
  values ('tok-nudge-guard', v_lead, 'Nudge Guard Test', 250, 'sent',
          now() - interval '10 days',
          '11111111-1111-1111-1111-111111111111')
  returning id into v_q;

  select count(*) into n from public.sms_due_quote_nudges(25) where quote_id = v_q;
  perform chk('a quote with no nudge yet is due one', n = 1, n::text);

  insert into public.sms_messages
    (direction, kind, phone, body, status, quote_id, lead_id, error)
  values ('out', 'nudge_sent', '+15415550505', 'nudge', 'undelivered',
          v_q, v_lead, 'destination not found');

  select count(*) into n from public.sms_due_quote_nudges(25) where quote_id = v_q;
  perform chk('THE POINT: a refused nudge is not rebuilt every night',
              n = 0, n::text);
end $$;

-- ---------------------------------------------------------------------------

do $$
declare
  bad int;
begin
  select failed into bad from _score;
  if bad > 0 then
    raise exception '% assertion(s) failed', bad;
  end if;
  raise notice '--- all assertions passed ---';
end $$;
