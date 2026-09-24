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

-- Assertions for db/sms-delivery.sql.
--
-- Run against a THROWAWAY Postgres, after verify/sms-fixture.sql, then
-- db/sms.sql, then db/sms-delivery.sql. Never against Supabase — the
-- fixture drops tables.
--
--   psql -d scratch -f verify/sms-fixture.sql
--   psql -d scratch -f db/sms.sql
--   psql -d scratch -f db/sms-delivery.sql
--   psql -d scratch -f verify/sms-delivery.sql
--
-- What this is actually checking
-- ------------------------------
-- One thing, mostly: that a text the carrier refused can never be sent
-- again by itself. The whole reason this migration invents an
-- 'undelivered' status instead of reusing 'failed' is that 'failed' frees
-- the double-send slot, and a freed slot means the nightly run texts the
-- same landline again tomorrow, and the day after, for as long as the
-- business exists.
--
-- Nothing errors when that goes wrong. Every send "succeeds" and every
-- night the row looks fine. So the assertions marked THE POINT are the
-- ones that would notice.

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
-- Which refusals are permanent
-- ---------------------------------------------------------------------------

select chk('"destination not found" is permanent',
           public.sb_sms_permanent('destination not found'));
select chk('a landline is permanent',
           public.sb_sms_permanent('Unable to receive message - landline or unreachable'));
select chk('a disconnected number is permanent',
           public.sb_sms_permanent('Destination number unknown or disconnected'));

-- THE POINT, pointed the other way. Writing a number off because a carrier
-- filtered one message is how a real customer stops hearing from us
-- forever, and it is a far worse failure than the one this file exists for.
select chk('THE POINT: spam filtering is NOT permanent',
           not public.sb_sms_permanent('Content flagged against carrier guidelines'));
select chk('THE POINT: a rate limit is NOT permanent',
           not public.sb_sms_permanent('Message blocked due to volume-based filtering'));
select chk('an unknown reason is NOT permanent',
           not public.sb_sms_permanent('something nobody has seen before'));
select chk('no reason at all is NOT permanent',
           not public.sb_sms_permanent(null));

-- ---------------------------------------------------------------------------
-- A quote to a landline
-- ---------------------------------------------------------------------------

do $$
declare
  lead_id  uuid;
  quote_id uuid;
  c        record;
begin
  -- Self-cleaning, so the file can be run twice against the same scratch
  -- database without the second run tripping over the first one's rows.
  delete from sms_unreachable;
  delete from sms_messages;
  delete from contact_log;
  delete from sms_opt_outs;
  delete from quotes;
  delete from leads;
  drop table if exists _t;

  insert into leads (name, phone, email)
  values ('Judy', '+15417577066', 'judy@example.com')
  returning id into lead_id;

  insert into quotes (token, lead_id, amount) values ('tok-judy', lead_id, 449)
  returning id into quote_id;

  -- Claim it and mark it sent, exactly as netlify/lib/sms.mjs does when Quo
  -- answers 202.
  select * into c
    from public.claim_sms('quote', '+15417577066', 'Here is your quote for $449',
                          lead_id, null, quote_id, null, null, true);
  perform public.mark_sms_sent(c.id, 'QUO-SID-1');

  create temp table _t (k text primary key, v text);
  insert into _t values ('lead', lead_id::text), ('quote', quote_id::text), ('msg', c.id::text);
end $$;

select chk('the quote text is recorded as sent',
           (select status from sms_messages where provider_sid = 'QUO-SID-1') = 'sent');

-- The existing failure path cannot express this, which is the whole reason
-- mark_sms_undelivered exists. mark_sms_failed only touches a 'queued' row.
do $$
begin
  perform public.mark_sms_failed(
    (select id from sms_messages where provider_sid = 'QUO-SID-1'),
    'destination not found');
end $$;

select chk('THE POINT: mark_sms_failed cannot touch an already-sent row',
           (select status from sms_messages where provider_sid = 'QUO-SID-1') = 'sent',
           'if this ever changes, the dedupe slot is being freed by a carrier rejection');

-- Now the carrier's verdict arrives.
do $$
declare r record;
begin
  select * into r from public.mark_sms_undelivered('QUO-SID-1', 'destination not found');
  insert into _t values ('returned_phone', r.out_phone), ('permanent', r.out_permanent::text);
end $$;

select chk('the row is now undelivered',
           (select status from sms_messages where provider_sid = 'QUO-SID-1') = 'undelivered');
select chk('the carrier''s reason is kept verbatim',
           (select error from sms_messages where provider_sid = 'QUO-SID-1') = 'destination not found');
select chk('it hands the caller the number back',
           (select v from _t where k = 'returned_phone') = '+15417577066');
select chk('and says the refusal was permanent',
           (select v from _t where k = 'permanent') = 'true');

-- THE POINT. The reason for the whole 'undelivered' state.
do $$
declare c record;
begin
  select * into c
    from public.claim_sms('quote', '+15417577066', 'Here is your quote for $449',
                          (select v from _t where k = 'lead')::uuid, null,
                          (select v from _t where k = 'quote')::uuid, null, null, true);
  insert into _t values ('retry_ok', c.ok::text), ('retry_reason', c.reason);
end $$;

select chk('THE POINT: an undelivered quote is not silently sent again',
           (select v from _t where k = 'retry_ok') = 'false',
           (select v from _t where k = 'retry_reason'));

-- ...and the number itself is now closed, so ANY text to it stops, not just
-- a repeat of this one.
do $$
declare c record;
begin
  select * into c
    from public.claim_sms('reminder', '+15417577066', 'See you tomorrow at 9',
                          (select v from _t where k = 'lead')::uuid, null, null, null, null, true);
  insert into _t values ('reminder_reason', c.reason);
end $$;

select chk('THE POINT: the number is closed to every kind of text',
           (select v from _t where k = 'reminder_reason') = 'unreachable',
           (select v from _t where k = 'reminder_reason'));

-- p_force is for quiet hours. It must not reach this, for the same reason
-- it must not reach an opt-out.
select chk('THE POINT: force does not override an unreachable number',
           (select reason from public.claim_sms(
              'manual', '+15417577066', 'hello', null, null, null, null, null, true)) = 'unreachable');

select chk('the timeline gained the undelivered entry',
           exists (select 1 from contact_log
                    where kind = 'text_undelivered'
                      and detail = 'destination not found'));

-- ---------------------------------------------------------------------------
-- The dedupe slot, on its own
-- ---------------------------------------------------------------------------
--
-- The assertion above ("an undelivered quote is not silently sent again")
-- looks like it tests the dedupe index. It does not, and reverting the
-- index to its old predicate leaves it green — because Judy's number is
-- ALSO unreachable by then, and claim_sms refuses on that first. Two guards
-- in a row, only one of them being measured.
--
-- The case that isolates the index is an undelivered message whose number
-- is still perfectly good: a carrier filtered one message, nothing is
-- written off, and the only thing standing between the nightly run and a
-- second send of the same quote is whether an 'undelivered' row still holds
-- its slot. That is the real landline-every-night bug, and it bites hardest
-- for the failures that are NOT permanent.

do $$
declare
  lead_id  uuid;
  quote_id uuid;
  c        record;
begin
  insert into leads (name, phone, email)
  values ('Nora', '+15412073254', 'nora@example.com')
  returning id into lead_id;
  insert into quotes (token, lead_id, amount)
  values ('tok-nora', lead_id, 180) returning id into quote_id;

  select * into c
    from public.claim_sms('quote', '+15412073254', 'quote for $180',
                          lead_id, null, quote_id, null, null, true);
  perform public.mark_sms_sent(c.id, 'QUO-SID-4');
  perform public.mark_sms_undelivered('QUO-SID-4', 'Content flagged against carrier guidelines');

  -- Same quote, same number, number still open for business.
  select * into c
    from public.claim_sms('quote', '+15412073254', 'quote for $180',
                          lead_id, null, quote_id, null, null, true);
  insert into _t values ('open_retry_ok', c.ok::text), ('open_retry_reason', c.reason);
end $$;

select chk('the number is still fine after a filtered message',
           not public.sb_sms_unreachable('+15412073254'));
select chk('THE POINT: an undelivered quote holds its slot even when the number is fine',
           (select v from _t where k = 'open_retry_ok') = 'false',
           'reason was: ' || (select v from _t where k = 'open_retry_reason'));
select chk('and it is refused as a duplicate, not as a dead number',
           (select v from _t where k = 'open_retry_reason') = 'already_sent',
           (select v from _t where k = 'open_retry_reason'));

-- ---------------------------------------------------------------------------
-- The same webhook twice
-- ---------------------------------------------------------------------------
-- Quo delivers at least once and retries anything that is not a 2xx.

do $$
declare n int;
begin
  perform public.mark_sms_undelivered('QUO-SID-1', 'destination not found');
  select count(*)::int into n from public.mark_sms_undelivered('QUO-SID-1', 'destination not found');
  insert into _t values ('second_rows', n::text);
end $$;

select chk('THE POINT: a repeated webhook returns nothing to act on',
           (select v from _t where k = 'second_rows') = '0',
           'otherwise the fallback email goes out again on every retry');
select chk('and does not double-count the failure',
           (select failures from sms_unreachable where phone = '+15417577066') = 1);

-- ---------------------------------------------------------------------------
-- A filtered message is not a dead number
-- ---------------------------------------------------------------------------

do $$
declare
  lead_id uuid;
  c       record;
  r       record;
begin
  insert into leads (name, phone, email)
  values ('Meagan', '+15419717024', 'meagan@example.com')
  returning id into lead_id;

  select * into c
    from public.claim_sms('manual', '+15419717024', 'quick note',
                          lead_id, null, null, null, null, true);
  perform public.mark_sms_sent(c.id, 'QUO-SID-2');
  select * into r from public.mark_sms_undelivered('QUO-SID-2', 'Content flagged against carrier guidelines');
  insert into _t values ('filtered_permanent', r.out_permanent::text);
end $$;

select chk('a filtered message is still recorded as undelivered',
           (select status from sms_messages where provider_sid = 'QUO-SID-2') = 'undelivered');
select chk('THE POINT: but the number is NOT written off',
           not public.sb_sms_unreachable('+15419717024'),
           'a real mobile must not be lost to one spam filter');
select chk('and a later text to it still goes through',
           (select ok from public.claim_sms(
              'manual', '+15419717024', 'another', null, null, null, null, null, true)) = true);

-- ---------------------------------------------------------------------------
-- Letting a number back in
-- ---------------------------------------------------------------------------

select chk('clearing an unreachable number reports that it did something',
           public.clear_sms_unreachable('+15417577066') = true);
select chk('after clearing, texts are allowed again',
           (select ok from public.claim_sms(
              'manual', '+15417577066', 'trying again', null, null, null, null, null, true)) = true);
select chk('clearing a number that was never blocked changes nothing',
           public.clear_sms_unreachable('+15035550000') = false);

-- A fresh refusal after somebody cleared it. Their decision was older than
-- the carrier's answer.
do $$
declare
  c record;
begin
  select * into c
    from public.claim_sms('manual', '+15417577066', 'once more',
                          null, null, null, null, null, true);
  perform public.mark_sms_sent(c.id, 'QUO-SID-3');
  perform public.mark_sms_undelivered('QUO-SID-3', 'destination not found');
end $$;

select chk('THE POINT: a new refusal re-closes a number somebody reopened',
           public.sb_sms_unreachable('+15417577066'));
select chk('and the failure count went up rather than starting over',
           (select failures from sms_unreachable where phone = '+15417577066') = 2);

-- ---------------------------------------------------------------------------
-- Things that must not have changed
-- ---------------------------------------------------------------------------

-- claim_sms was rewritten in full to add one check. Everything else it did
-- has to still be true.

do $$
begin
  insert into sms_opt_outs (phone) values ('+15412868421')
  on conflict do nothing;
end $$;

select chk('opt-out still wins',
           (select reason from public.claim_sms(
              'manual', '+15412868421', 'hello', null, null, null, null, null, true)) = 'opted_out');
select chk('a bad number is still a bad number',
           (select reason from public.claim_sms(
              'manual', 'nonsense', 'hello', null, null, null, null, null, true)) = 'bad_number');
select chk('an empty body is still refused',
           (select reason from public.claim_sms(
              'manual', '+15035551212', '   ', null, null, null, null, null, true)) = 'empty_body');

-- And the original meaning of 'failed' — the run died, nobody saw it, try
-- again — has to survive, or an outage becomes permanent data loss.
do $$
declare
  lead_id  uuid;
  quote_id uuid;
  c        record;
begin
  insert into leads (name, phone) values ('Denise', '+12069621223')
  returning id into lead_id;
  insert into quotes (token, lead_id, amount) values ('tok-denise', lead_id, 250)
  returning id into quote_id;

  select * into c
    from public.claim_sms('quote', '+12069621223', 'quote',
                          lead_id, null, quote_id, null, null, true);
  perform public.mark_sms_failed(c.id, 'the run died');

  select * into c
    from public.claim_sms('quote', '+12069621223', 'quote',
                          lead_id, null, quote_id, null, null, true);
  insert into _t values ('after_failed_ok', c.ok::text);
end $$;

select chk('THE POINT: a genuinely failed send can still be retried',
           (select v from _t where k = 'after_failed_ok') = 'true',
           'the dedupe index must keep letting failed rows out');

-- ---------------------------------------------------------------------------
-- Sending it the other way
-- ---------------------------------------------------------------------------

select chk('a quote with an email address comes back',
           (select out_email from public.quote_for_email(
              (select v from _t where k = 'quote')::uuid)) = 'judy@example.com');
select chk('with the token, so a link can be built',
           (select out_token from public.quote_for_email(
              (select v from _t where k = 'quote')::uuid)) = 'tok-judy');
select chk('and the amount, so the email says the same number the text did',
           (select out_amount from public.quote_for_email(
              (select v from _t where k = 'quote')::uuid)) = 449);
select chk('and a name to open with',
           (select out_name from public.quote_for_email(
              (select v from _t where k = 'quote')::uuid)) = 'Judy');

-- THE POINT. No address is not an error, it is the ordinary case for a lead
-- taken over the phone — and the caller has to be able to tell the
-- difference between "no email" and "something went wrong".
do $$
declare
  lead_id  uuid;
  quote_id uuid;
begin
  insert into leads (name, phone) values ('No Email', '+15035551234')
  returning id into lead_id;
  insert into quotes (token, lead_id, amount)
  values ('tok-noemail', lead_id, 99) returning id into quote_id;
  insert into _t values ('noemail_quote', quote_id::text);
end $$;

select chk('THE POINT: a quote with nobody to email returns no row at all',
           not exists (select 1 from public.quote_for_email(
             (select v from _t where k = 'noemail_quote')::uuid)),
           'an empty string or a null row would be emailed to nowhere');

-- ---------------------------------------------------------------------------
-- The list to work through
-- ---------------------------------------------------------------------------

select chk('the failures view shows the undelivered quote',
           exists (select 1 from sms_failures where error = 'destination not found'));
-- By provider_sid, not by error text. Three different messages in this file
-- end up with "destination not found" against the same number, and picking
-- one of them by its reason picks whichever sorted first.
select chk('with the person attached',
           (select who from sms_failures where provider_sid = 'QUO-SID-1') = 'Judy');
select chk('and their email, so it can be sent another way',
           (select email from sms_failures where provider_sid = 'QUO-SID-1') = 'judy@example.com');
select chk('and Quo''s message id, for chasing it with them',
           (select provider_sid from sms_failures where provider_sid = 'QUO-SID-1') = 'QUO-SID-1');
select chk('it includes genuinely failed sends too',
           exists (select 1 from sms_failures where error = 'the run died'));
select chk('it says which failures were permanent',
           (select permanent from sms_failures where provider_sid = 'QUO-SID-1') = true);

-- security_invoker, for the reason db/rls-phase-1b.sql exists: a view
-- without it runs as its owner and hands out rows the caller's policies
-- would have refused.
select chk('THE POINT: the failures view runs as the caller, not its owner',
           (select reloptions::text from pg_class where relname = 'sms_failures')
             like '%security_invoker=%');

-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  select failed into n from _score;
  if n > 0 then
    raise exception '% assertion(s) failed', n;
  else
    raise notice 'all assertions passed';
  end if;
end $$;
