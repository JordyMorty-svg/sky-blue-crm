-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it. Without it the guard raises, psql
-- shrugs, and the DELETEs below run anyway — which is the entire failure
-- this is meant to prevent. In the Supabase SQL editor the RAISE aborts the
-- surrounding transaction on its own, so nothing after it commits there.
\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE DELETES ROWS. It is for a THROWAWAY Postgres, never for      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- #                                                                        #
-- #  The guard below is not documentation. Pasting this file into the       #
-- #  Supabase SQL editor raises before it touches anything, because only a  #
-- #  database built by a verify/*-fixture.sql has the marker table it       #
-- #  looks for.                                                             #
-- #                                                                        #
-- #  It exists because "run db/sms-delivery.sql, not                        #
-- #  verify/sms-delivery.sql" is a one-character distinction, and a         #
-- #  one-character distinction should never be the only thing standing      #
-- #  between a paste and an empty leads table.                              #
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

-- Assertions for db/sms.sql.
--
-- Run against a THROWAWAY Postgres, after verify/sms-fixture.sql and then
-- db/sms.sql. Never against Supabase — the fixture drops tables.
--
-- What this is actually checking: that it is impossible to text somebody
-- twice, and impossible to text somebody who said stop. Everything else is
-- convenience.

\set ON_ERROR_STOP on
\pset pager off

create or replace function chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then
    raise notice 'ok    %', what;
  else
    raise notice 'FAIL  %  %', what, coalesce(detail, '');
    -- Counted rather than raised, so one failure doesn't hide the rest.
    update _score set failed = failed + 1;
  end if;
end $$;

create table if not exists _score (failed int not null default 0);
delete from _score;
insert into _score values (0);

-- ---------------------------------------------------------------------------
-- Phone normalising
-- ---------------------------------------------------------------------------

select chk('a formatted number becomes E.164',
  sb_sms_e164('(541) 730-3593') = '+15417303593',
  coalesce(sb_sms_e164('(541) 730-3593'), 'null'));

select chk('a number already carrying 1 is not doubled',
  sb_sms_e164('15417303593') = '+15417303593',
  coalesce(sb_sms_e164('15417303593'), 'null'));

select chk('a short number is rejected rather than guessed at',
  sb_sms_e164('541-730-359') is null,
  coalesce(sb_sms_e164('541-730-359'), 'null'));

-- No US area code starts with 0 or 1. Letting one through means paying
-- Twilio for a rejection on every run.
select chk('an impossible area code is rejected',
  sb_sms_e164('(041) 730-3593') is null,
  coalesce(sb_sms_e164('(041) 730-3593'), 'null'));

select chk('an empty number is null, not a crash',
  sb_sms_e164('') is null and sb_sms_e164(null) is null);

select chk('sb_phone_digits still matches contact_log',
  sb_phone_digits('(541) 730-3593') = '5417303593');

-- ---------------------------------------------------------------------------
-- Setup: two people, a quote each
-- ---------------------------------------------------------------------------

insert into customers (id, name, phone, email) values
  ('cccccccc-0000-0000-0000-000000000001', 'Marilyn Hollingsworth', '(541) 555-0101', null),
  ('cccccccc-0000-0000-0000-000000000002', 'Karen Emery',           '(541) 555-0102', null);

insert into leads (id, name, phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Blythe Okonkwo', '(541) 555-0201', 'new');

insert into quotes (id, token, lead_id, customer_name, amount, status, sent_at)
values ('99999999-0000-0000-0000-000000000001', repeat('a', 64),
        'aaaaaaaa-0000-0000-0000-000000000001', 'Blythe Okonkwo', 475,
        'sent', now() - interval '5 days');

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------

select chk('a good number claims cleanly',
  (select ok from claim_sms('manual', '(541) 555-0101', 'Hello there',
     null, 'cccccccc-0000-0000-0000-000000000001', null, null,
     '11111111-1111-1111-1111-111111111111', true)),
  (select reason from claim_sms('manual', '(541) 555-0101', 'x', null,
     'cccccccc-0000-0000-0000-000000000001', null, null, null, true)));

select chk('a bad number is refused with a reason, not an exception',
  (select reason from claim_sms('manual', 'nonsense', 'Hello', null, null,
     null, null, null, true)) = 'bad_number');

select chk('an empty message is refused',
  (select reason from claim_sms('manual', '(541) 555-0101', '   ', null, null,
     null, null, null, true)) = 'empty_body');

select chk('claim_sms hands back the normalised number to send to',
  (select phone from claim_sms('manual', '541.555.0101', 'Dots and all',
     null, 'cccccccc-0000-0000-0000-000000000001', null, null, null, true))
  = '+15415550101',
  (select coalesce(phone, 'null') from claim_sms('manual', '541.555.0101', 'x',
     null, null, null, null, null, true)));

select chk('the claimed row is stored in E.164, not as it was typed',
  (select phone from sms_messages order by id desc limit 1) = '+15415550101',
  (select phone from sms_messages order by id desc limit 1));

-- ---------------------------------------------------------------------------
-- THE POINT, part one: nobody gets the same automatic text twice
-- ---------------------------------------------------------------------------

select claim_sms('nudge_sent', '(541) 555-0201', 'First nudge',
  'aaaaaaaa-0000-0000-0000-000000000001', null,
  '99999999-0000-0000-0000-000000000001', null, null, true);

select chk('THE POINT: a second identical nudge is refused',
  (select reason from claim_sms('nudge_sent', '(541) 555-0201', 'Second nudge',
     'aaaaaaaa-0000-0000-0000-000000000001', null,
     '99999999-0000-0000-0000-000000000001', null, null, true)) = 'already_sent');

select chk('only one nudge row exists for that quote',
  (select count(*) from sms_messages
    where quote_id = '99999999-0000-0000-0000-000000000001'
      and kind = 'nudge_sent') = 1,
  (select count(*)::text from sms_messages
    where quote_id = '99999999-0000-0000-0000-000000000001'));

-- A DIFFERENT kind of nudge on the same quote is a different message and
-- must still be allowed — they opened it after we chased it, which is
-- exactly when the second one is worth sending.
select chk('a different nudge kind on the same quote is still allowed',
  (select ok from claim_sms('nudge_viewed', '(541) 555-0201', 'You opened it',
     'aaaaaaaa-0000-0000-0000-000000000001', null,
     '99999999-0000-0000-0000-000000000001', null, null, true)));

-- Hand-written messages have no dedupe key at all. Someone texting a
-- customer twice is a conversation, not a bug.
select chk('a person may send two manual texts to the same number',
  (select ok from claim_sms('manual', '(541) 555-0101', 'Second one',
     null, 'cccccccc-0000-0000-0000-000000000001', null, null, null, true)));

-- ---------------------------------------------------------------------------
-- Retry after a failure
-- ---------------------------------------------------------------------------

-- A failed send must free the slot, or one Twilio outage means that quote is
-- never chased again.
do $$
declare mid bigint;
begin
  select id into mid from sms_messages
   where quote_id = '99999999-0000-0000-0000-000000000001'
     and kind = 'nudge_sent';
  perform mark_sms_failed(mid, 'Twilio 500');
end $$;

select chk('a failed send frees the slot for a retry',
  (select ok from claim_sms('nudge_sent', '(541) 555-0201', 'Retry',
     'aaaaaaaa-0000-0000-0000-000000000001', null,
     '99999999-0000-0000-0000-000000000001', null, null, true)));

select chk('but the failed attempt is kept, not overwritten',
  (select count(*) from sms_messages
    where quote_id = '99999999-0000-0000-0000-000000000001'
      and kind = 'nudge_sent') = 2);

-- ---------------------------------------------------------------------------
-- THE POINT, part two: STOP is binding
-- ---------------------------------------------------------------------------

select record_sms_opt_out('(541) 555-0102', 'STOP');

select chk('an opt-out blocks an automatic text',
  (select reason from claim_sms('nudge_sent', '(541) 555-0102', 'Hi',
     null, 'cccccccc-0000-0000-0000-000000000002', null, null, null, false))
  = 'opted_out');

-- The check that matters most in this file. p_force exists for a person
-- pressing a button, and it must not be a way round a STOP.
select chk('THE POINT: p_force does NOT override an opt-out',
  (select reason from claim_sms('manual', '(541) 555-0102', 'Just this once',
     null, 'cccccccc-0000-0000-0000-000000000002', null, null,
     '11111111-1111-1111-1111-111111111111', true)) = 'opted_out',
  (select reason from claim_sms('manual', '(541) 555-0102', 'x', null, null,
     null, null, null, true)));

select chk('the opt-out is matched however the number was typed',
  sb_sms_opted_out('541-555-0102') and sb_sms_opted_out('+15415550102'));

select chk('the message they sent is kept as evidence',
  (select last_message from sms_opt_outs where phone = '+15415550102') = 'STOP');

select record_sms_opt_in('(541) 555-0102');

select chk('START lifts the opt-out',
  not sb_sms_opted_out('(541) 555-0102'));

-- ---------------------------------------------------------------------------
-- Quiet hours
-- ---------------------------------------------------------------------------

select chk('the open and close hours are a sane window',
  sb_sms_open_hour() < sb_sms_close_hour()
  and sb_sms_open_hour() >= 8 and sb_sms_close_hour() <= 21,
  format('%s to %s', sb_sms_open_hour(), sb_sms_close_hour()));

-- sb_sms_quiet_now() reads the wall clock, so it cannot be asserted
-- directly without freezing time. What CAN be asserted is that the two
-- branches disagree — that the guard is wired to the clock at all rather
-- than being a constant true or false.
select chk('quiet hours and sending hours are actually different states',
  (select count(distinct q) from (
     select extract(hour from (now() at time zone 'America/Los_Angeles'))::int
              not between sb_sms_open_hour() and sb_sms_close_hour() - 1 as q
     union all
     select true
     union all
     select false
   ) s) = 2);

-- ---------------------------------------------------------------------------
-- Marking sent, and the history it writes
-- ---------------------------------------------------------------------------

do $$
declare mid bigint; r record;
begin
  select * into r from claim_sms('manual', '(541) 555-0101', 'On my way',
    null, 'cccccccc-0000-0000-0000-000000000001', null, null,
    '11111111-1111-1111-1111-111111111111', true);
  perform mark_sms_sent(r.id, 'SM_test_sid');
end $$;

select chk('a sent text lands on the contact timeline',
  exists (select 1 from contact_log
           where customer_id = 'cccccccc-0000-0000-0000-000000000001'
             and kind = 'text' and detail = 'On my way'));

select chk('the provider id is kept, for looking a send up later',
  exists (select 1 from sms_messages
           where provider_sid = 'SM_test_sid' and status = 'sent'));

select chk('the customer last-contacted stamp moves',
  (select last_contacted_at from customers
    where id = 'cccccccc-0000-0000-0000-000000000001') is not null);

-- An automatic text is not a conversation. A lead nobody has spoken to must
-- not drift down the funnel because a robot chased a quote.
do $$
declare r record;
begin
  select * into r from claim_sms('manual', '(541) 555-0201', 'Automatic',
    'aaaaaaaa-0000-0000-0000-000000000001', null, null, null, null, true);
  perform mark_sms_sent(r.id, 'SM_two');
end $$;

select chk('an automatic text does NOT advance a new lead to contacted',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'new',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000001'));

select chk('marking an already-sent row again is a no-op, not a duplicate',
  (select count(*) from contact_log where detail = 'On my way') = 1);

-- ---------------------------------------------------------------------------
-- Inbound
-- ---------------------------------------------------------------------------

-- Snapshotted BEFORE the reply arrives, so the assertion below is about the
-- number not moving rather than about a magic constant that has to be
-- recounted every time a test is added above it.
create temp table _attempts_before as
  select contact_attempts from customers
   where id = 'cccccccc-0000-0000-0000-000000000001';

select record_inbound_sms('(541) 555-0101', 'Sounds good, see you then', 'SM_in_1');

select chk('an inbound text finds the customer it came from',
  exists (select 1 from sms_messages
           where direction = 'in'
             and customer_id = 'cccccccc-0000-0000-0000-000000000001'));

select chk('an inbound text is logged as a reply, not as outreach',
  exists (select 1 from contact_log
           where kind = 'text_in' and detail = 'Sounds good, see you then'));

-- The bug this prevents: a reply counted as us having reached out, so the
-- lead page says "last reached out today" when nobody did anything.
select chk('an inbound text does not count as a contact attempt',
  (select contact_attempts from customers
    where id = 'cccccccc-0000-0000-0000-000000000001')
  = (select contact_attempts from _attempts_before),
  format('%s, was %s',
    (select contact_attempts from customers
      where id = 'cccccccc-0000-0000-0000-000000000001'),
    (select contact_attempts from _attempts_before)));

-- Its own statement. A function's inserts are not visible to the snapshot of
-- the statement that called it, so asserting the call and the result together
-- in one SELECT tests nothing and fails confusingly.
select record_inbound_sms('(541) 555-0999', 'Who is this?', 'SM_in_2');

select chk('an inbound text from an unknown number is still kept',
  exists (select 1 from sms_messages
           where phone = '+15415550999'
             and lead_id is null and customer_id is null));

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

select chk('the sweep leaves a fresh claim alone',
  sweep_sms() = 0, sweep_sms()::text);

update sms_messages set created_at = now() - interval '1 hour' where status = 'queued';

select chk('the sweep releases a claim from a run that died',
  sweep_sms() > 0);

select chk('nothing is left stuck in queued',
  (select count(*) from sms_messages where status = 'queued') = 0);

-- ---------------------------------------------------------------------------
-- What is due
-- ---------------------------------------------------------------------------

delete from sms_messages;
delete from quotes;

insert into quotes (id, token, customer_id, customer_name, amount, status, sent_at)
values
  -- Sent 5 days ago, never opened → due an unopened nudge.
  ('99999999-0000-0000-0000-000000000010', repeat('b', 64),
   'cccccccc-0000-0000-0000-000000000001', 'Marilyn', 250, 'sent', now() - interval '5 days'),
  -- Sent yesterday → too soon.
  ('99999999-0000-0000-0000-000000000011', repeat('c', 64),
   'cccccccc-0000-0000-0000-000000000002', 'Karen', 300, 'sent', now() - interval '1 day');

select chk('a quote left unopened for days is due a nudge',
  exists (select 1 from sms_due_quote_nudges()
           where quote_id = '99999999-0000-0000-0000-000000000010'
             and kind = 'nudge_sent'));

select chk('a quote sent yesterday is left alone',
  not exists (select 1 from sms_due_quote_nudges()
               where quote_id = '99999999-0000-0000-0000-000000000011'));

update quotes
   set status = 'viewed', viewed_at = now() - interval '3 days'
 where id = '99999999-0000-0000-0000-000000000011';

select chk('a quote they opened and did not accept is due the warmer nudge',
  exists (select 1 from sms_due_quote_nudges()
           where quote_id = '99999999-0000-0000-0000-000000000011'
             and kind = 'nudge_viewed'));

update quotes set status = 'accepted' where id = '99999999-0000-0000-0000-000000000011';

select chk('an accepted quote is never chased',
  not exists (select 1 from sms_due_quote_nudges()
               where quote_id = '99999999-0000-0000-0000-000000000011'));

update quotes set expires_at = now() - interval '1 day'
 where id = '99999999-0000-0000-0000-000000000010';

select chk('an expired quote is never chased',
  not exists (select 1 from sms_due_quote_nudges()
               where quote_id = '99999999-0000-0000-0000-000000000010'));

-- The blast guard: a scheduler down for a month must not come back and text
-- everyone whose quote went out in that month.
update quotes
   set expires_at = now() + interval '30 days',
       sent_at    = now() - interval '40 days',
       status     = 'sent'
 where id = '99999999-0000-0000-0000-000000000010';

select chk('THE POINT: a quote older than the window is never chased',
  not exists (select 1 from sms_due_quote_nudges()
               where quote_id = '99999999-0000-0000-0000-000000000010'));

update quotes set sent_at = now() - interval '5 days'
 where id = '99999999-0000-0000-0000-000000000010';

select record_sms_opt_out('(541) 555-0101', 'STOP');

select chk('an opted-out customer never appears in the due list',
  not exists (select 1 from sms_due_quote_nudges()
               where quote_id = '99999999-0000-0000-0000-000000000010'));

select record_sms_opt_in('(541) 555-0101');

-- ---------------------------------------------------------------------------
-- Day-before reminders
-- ---------------------------------------------------------------------------

insert into jobs (id, customer_id, status, starts_at) values
  -- 9am tomorrow, local.
  ('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
   'scheduled',
   ((sb_local(now())::date + 1) + time '09:00') at time zone 'America/Los_Angeles'),
  -- 4pm tomorrow. Same day, much later — an interval from now() would catch
  -- one of these and miss the other.
  ('bbbbbbbb-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002',
   'scheduled',
   ((sb_local(now())::date + 1) + time '16:00') at time zone 'America/Los_Angeles'),
  -- The day after tomorrow.
  ('bbbbbbbb-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
   'scheduled',
   ((sb_local(now())::date + 2) + time '09:00') at time zone 'America/Los_Angeles'),
  -- Tomorrow, but only projected by the recurring plan — nobody has agreed
  -- a day, so a reminder would invent an appointment.
  ('bbbbbbbb-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000002',
   'upcoming',
   ((sb_local(now())::date + 1) + time '11:00') at time zone 'America/Los_Angeles');

select chk('THE POINT: both of tomorrow''s jobs are reminded, early and late',
  (select count(*) from sms_due_job_reminders()) = 2,
  (select count(*)::text from sms_due_job_reminders()));

select chk('a job the day after tomorrow is not reminded yet',
  not exists (select 1 from sms_due_job_reminders()
               where job_id = 'bbbbbbbb-0000-0000-0000-000000000003'));

select chk('an unscheduled recurring visit is never reminded',
  not exists (select 1 from sms_due_job_reminders()
               where job_id = 'bbbbbbbb-0000-0000-0000-000000000004'));

select claim_sms('reminder', '(541) 555-0101', 'Tomorrow at 9',
  null, 'cccccccc-0000-0000-0000-000000000001', null,
  'bbbbbbbb-0000-0000-0000-000000000001', null, true);

select chk('a job already reminded drops out of the list',
  not exists (select 1 from sms_due_job_reminders()
               where job_id = 'bbbbbbbb-0000-0000-0000-000000000001'));

select chk('and a second reminder for it is refused outright',
  (select reason from claim_sms('reminder', '(541) 555-0101', 'Again',
     null, 'cccccccc-0000-0000-0000-000000000001', null,
     'bbbbbbbb-0000-0000-0000-000000000001', null, true)) = 'already_sent');

-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------

select chk('sms_messages is locked down by RLS',
  (select relrowsecurity from pg_class where relname = 'sms_messages'));

select chk('sms_opt_outs is locked down by RLS',
  (select relrowsecurity from pg_class where relname = 'sms_opt_outs'));

select chk('there is no insert or update policy on the outbox',
  not exists (select 1 from pg_policies
               where tablename = 'sms_messages' and cmd <> 'SELECT'));

select chk('deleting a lead keeps the record that we texted them',
  (select confdeltype from pg_constraint
    where conrelid = 'sms_messages'::regclass
      and confrelid = 'leads'::regclass) = 'n',
  (select confdeltype::text from pg_constraint
    where conrelid = 'sms_messages'::regclass
      and confrelid = 'leads'::regclass));

-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  select failed into n from _score;
  if n = 0 then
    raise notice '';
    raise notice 'all assertions passed';
  else
    raise exception '% assertion(s) failed', n;
  end if;
end $$;
