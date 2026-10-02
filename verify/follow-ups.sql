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

-- Assertions for db/follow-ups.sql, now that a review request can go out as
-- a text to a customer who has no email address.
--
-- Run against a THROWAWAY Postgres, in this order:
--   verify/sms-fixture.sql
--   db/sms.sql
--   db/sms-delivery.sql
--   verify/follow-up-fixture.sql
--   db/follow-ups.sql
--   verify/follow-ups.sql        <- this
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- Four things above everything else.
--
-- NOBODY IS ASKED TWICE. One review request per job, by either route, and
-- one per customer per twelve months. A second one says the business is a
-- machine that isn't listening, from the same number the first came from.
--
-- AN OPT-OUT CLOSES BOTH DOORS. Somebody who clicked unsubscribe must not
-- then get a text, however carefully the unsubscribe wording could be read.
-- This is the condition most likely to be "simplified" by someone later.
--
-- A TEXT IS RECORDED ONCE. mark_sms_sent already writes the contact history
-- for an outbound text. mark_follow_up_sent writing a second row is how a
-- customer timeline shows one message twice — the exact complaint that got
-- the duplicate invoice rows cleaned out of job history.
--
-- THE OTHER TEXTS STILL DEDUPLICATE. Teaching sms_messages.dedupe_key about
-- review texts means dropping and rebuilding a generated column. Leave a
-- case out of the rebuild and quotes start going twice — which is not a
-- review-request bug, and is how db/lead-ack.sql nearly shipped.
--
-- Checks marked THE POINT are the ones this change exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then
    raise notice 'ok    %', what;
  else
    raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Which way to reach somebody
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.chk('an email address wins',
    public.sb_follow_up_channel('a@b.com', false, '5417303593') = 'email');

  perform pg_temp.chk('THE POINT: no email, but a number, is a text',
    public.sb_follow_up_channel(null, false, '541 730 3593') = 'sms');

  perform pg_temp.chk('an empty-string email is not an email address',
    public.sb_follow_up_channel('   ', false, '5417303593') = 'sms');

  perform pg_temp.chk('neither is no way to ask at all',
    public.sb_follow_up_channel(null, false, null) is null);

  perform pg_temp.chk('a number that is not a number is not a route',
    public.sb_follow_up_channel(null, false, 'ring the doorbell') is null);

  perform pg_temp.chk(
    'THE POINT: an email opt-out closes the text route too',
    public.sb_follow_up_channel('a@b.com', true, '5417303593') is null,
    'they asked not to be asked; the wording of the unsubscribe link is not a loophole');

  perform pg_temp.chk('...even when there was never an email address',
    public.sb_follow_up_channel(null, true, '5417303593') is null);
end $$;

-- A number on the STOP list.
insert into public.sms_opt_outs (phone, source)
values (public.sb_sms_e164('5415550144'), 'test');

do $$
begin
  perform pg_temp.chk('THE POINT: a number that replied STOP is not a route',
    public.sb_follow_up_channel(null, false, '5415550144') is null);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Who gets claimed
-- ---------------------------------------------------------------------------

do $$
declare
  by_email  uuid;
  by_phone  uuid;
  no_route  uuid;
  stopped   uuid;
  j_email   uuid;
  j_phone   uuid;
  j_none    uuid;
  j_stopped uuid;
  rows_out  int;
  chan      text;
  ph        text;
begin
  insert into public.customers (name, email, phone) values
    ('Emma Email',   'emma@example.com', '5415550101') returning id into by_email;
  insert into public.customers (name, email, phone) values
    ('Phil Phone',   null,               '5415550102') returning id into by_phone;
  insert into public.customers (name, email, phone) values
    ('Nora Nothing', null,               null)         returning id into no_route;
  insert into public.customers (name, email, phone) values
    ('Stan Stop',    null,               '5415550144') returning id into stopped;

  -- A job apiece, scheduled, then completed — the trigger only fires on the
  -- transition, which is the whole reason importing history doesn't queue
  -- hundreds of these.
  insert into public.jobs (customer_id, status, services, price)
    values (by_email, 'scheduled', 'Windows', 300) returning id into j_email;
  insert into public.jobs (customer_id, status, services, price)
    values (by_phone, 'scheduled', 'Gutters', 250) returning id into j_phone;
  insert into public.jobs (customer_id, status, services, price)
    values (no_route, 'scheduled', 'Windows', 200) returning id into j_none;
  insert into public.jobs (customer_id, status, services, price)
    values (stopped,  'scheduled', 'Windows', 200) returning id into j_stopped;

  update public.jobs
  set status = 'completed', completed_at = now() - interval '4 days'
  where id in (j_email, j_phone, j_none, j_stopped);

  select count(*) into rows_out from public.follow_ups;
  perform pg_temp.chk('completing a job queues a follow-up, whatever we have for them',
    rows_out = 4, rows_out::text);

  -- Due dates are midnight-local on the third day, so a job four days ago is
  -- due. Nothing here needs to fiddle with them.
  select count(*) into rows_out from public.claim_follow_ups(25);
  perform pg_temp.chk('THE POINT: only the two reachable customers are claimed',
    rows_out = 2, rows_out || ' claimed');

  -- Read back through claim_follow_ups rather than recomputing the channel
  -- here. A test that works out the answer the same way the code does will
  -- agree with it however wrong both are.
  update public.follow_ups set status = 'pending', attempts = 0
  where job_id in (j_email, j_phone);

  select x.channel, x.phone into chan, ph
  from public.claim_follow_ups(25) x
  where x.customer_id = by_phone;

  perform pg_temp.chk('the phone-only customer is routed to sms', chan = 'sms', chan);
  perform pg_temp.chk('and the number is handed on in E.164, not as typed',
    ph = '+15415550102', ph);

  perform pg_temp.chk(
    'THE POINT: a customer with no email and no phone is left pending, not claimed',
    (select status from public.follow_ups where job_id = j_none) = 'pending');

  perform pg_temp.chk('and so is one whose number replied STOP',
    (select status from public.follow_ups where job_id = j_stopped) = 'pending');

  -- Put the two claimed rows back for the next section.
  update public.follow_ups set status = 'pending', attempts = 0
  where job_id in (j_email, j_phone);
end $$;

-- ---------------------------------------------------------------------------
-- 3. The preview tells the truth about the run
-- ---------------------------------------------------------------------------
--
-- A preview is only worth having if it is the same query. These are two
-- different function bodies, so the only way to know they agree is to ask
-- them both and compare — which is what this does, rather than reading the
-- two WHERE clauses and nodding.

do $$
declare
  previewed text;
  claimed   text;
begin
  select string_agg(follow_up_id || ':' || channel, ',' order by follow_up_id)
    into previewed
  from public.preview_follow_ups(25);

  select string_agg(follow_up_id || ':' || channel, ',' order by follow_up_id)
    into claimed
  from public.claim_follow_ups(25);

  perform pg_temp.chk(
    'THE POINT: the preview names the same rows, by the same route, as the run',
    previewed is not distinct from claimed,
    'preview ' || coalesce(previewed, '(none)') || ' vs run ' || coalesce(claimed, '(none)'));

  perform pg_temp.chk('and it found something, so the comparison meant something',
    previewed is not null, 'both were empty');

  update public.follow_ups set status = 'pending', attempts = 0 where status = 'sending';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Recording a text, once
-- ---------------------------------------------------------------------------

do $$
declare
  cust   uuid;
  fid    bigint;
  logs   int;
  sentto text;
  asked  timestamptz;
begin
  select f.id, f.customer_id into fid, cust
  from public.follow_ups f
  join public.customers c on c.id = f.customer_id
  where c.name = 'Phil Phone';

  delete from public.contact_log where customer_id = cust;

  perform public.mark_follow_up_sent(fid, 'quo_abc', '+15415550102', 'sms');

  select status, sent_to into sentto, sentto from public.follow_ups where id = fid;
  select sent_to into sentto from public.follow_ups where id = fid;
  perform pg_temp.chk('a sent text marks the row sent',
    (select status from public.follow_ups where id = fid) = 'sent');
  perform pg_temp.chk('and records the NUMBER as what it was sent to, not a blank email',
    sentto = '+15415550102', coalesce(sentto, '(null)'));

  select last_review_request_at into asked from public.customers where id = cust;
  perform pg_temp.chk('the twelve-month quiet period starts for a text too',
    asked is not null);

  select count(*) into logs from public.contact_log where customer_id = cust;
  perform pg_temp.chk(
    'THE POINT: no second contact_log row for a text — mark_sms_sent already wrote one',
    logs = 0, logs || ' rows; the timeline would show one message twice');
end $$;

do $$
declare
  cust uuid;
  fid  bigint;
  logs int;
begin
  select f.id, f.customer_id into fid, cust
  from public.follow_ups f
  join public.customers c on c.id = f.customer_id
  where c.name = 'Emma Email';

  delete from public.contact_log where customer_id = cust;

  perform public.mark_follow_up_sent(fid, 'resend_abc', 'emma@example.com', 'email');

  select count(*) into logs
  from public.contact_log where customer_id = cust and kind = 'auto_email';
  perform pg_temp.chk('an email still writes its one contact_log row', logs = 1, logs::text);
end $$;

-- ---------------------------------------------------------------------------
-- 5. "Not now" is not a failure
-- ---------------------------------------------------------------------------

do $$
declare
  j    uuid;
  cust uuid;
  fid  bigint;
  st   text;
  att  int;
begin
  select id into cust from public.customers where name = 'Nora Nothing';
  select id into j from public.jobs where customer_id = cust;

  update public.follow_ups
  set status = 'sending', attempts = 1, note = null
  where job_id = j
  returning id into fid;

  perform public.mark_follow_up_deferred(fid, 'quiet_hours');

  select status, attempts into st, att from public.follow_ups where id = fid;
  perform pg_temp.chk('THE POINT: a deferral puts the row back in the queue',
    st = 'pending', st);
  perform pg_temp.chk(
    'THE POINT: and gives back the attempt, so three quiet mornings can''t skip somebody',
    att = 0, att::text);
  perform pg_temp.chk('and says why, in the note',
    (select note from public.follow_ups where id = fid) = 'quiet_hours');

  -- A deferral must only act on a row this run claimed. Otherwise a late
  -- reply from a dead run could resurrect something already closed out.
  update public.follow_ups set status = 'skipped', note = 'done' where id = fid;
  perform public.mark_follow_up_deferred(fid, 'quiet_hours');
  perform pg_temp.chk('a deferral does not touch a row that was not being sent',
    (select status from public.follow_ups where id = fid) = 'skipped');
end $$;

-- ---------------------------------------------------------------------------
-- 6. The sweep says the useful thing
-- ---------------------------------------------------------------------------

do $$
declare
  cust uuid;
  j    uuid;
  note text;
begin
  -- No email, no phone, and now out of time.
  select id into cust from public.customers where name = 'Nora Nothing';
  select id into j from public.jobs where customer_id = cust;
  update public.follow_ups set status = 'pending', note = null where job_id = j;
  update public.jobs set completed_at = now() - interval '40 days' where id = j;

  perform public.sweep_follow_ups();

  select f.note into note from public.follow_ups f where f.job_id = j;
  perform pg_temp.chk(
    'THE POINT: a customer we cannot reach is filed as that, not "missed its window"',
    note = 'No email address or phone number on file', coalesce(note, '(null)'));

  -- Replied STOP, and now out of time.
  select id into cust from public.customers where name = 'Stan Stop';
  select id into j from public.jobs where customer_id = cust;
  update public.follow_ups set status = 'pending', note = null where job_id = j;
  update public.jobs set completed_at = now() - interval '40 days' where id = j;

  perform public.sweep_follow_ups();

  select f.note into note from public.follow_ups f where f.job_id = j;
  perform pg_temp.chk('and a STOP reply is named as the reason, not hidden as a missing address',
    note like '%STOP%', coalesce(note, '(null)'));
end $$;

-- ---------------------------------------------------------------------------
-- 7. The button
-- ---------------------------------------------------------------------------

do $$
declare
  cust  uuid;
  opted uuid;
  j     uuid;
  chan  text;
  threw text;
begin
  -- Phone only: the button should work, by text.
  select id into cust from public.customers where name = 'Phil Phone';
  select channel into chan from public.claim_manual_follow_up(cust);
  perform pg_temp.chk('THE POINT: "send now" works for a customer with only a phone number',
    chan = 'sms', coalesce(chan, '(null)'));

  -- Unsubscribed, with a perfectly good phone number.
  insert into public.customers (name, email, phone, email_opt_out)
  values ('Olive Optout', 'olive@example.com', '5415550155', true)
  returning id into opted;
  insert into public.jobs (customer_id, status, services, price)
  values (opted, 'scheduled', 'Windows', 100) returning id into j;
  update public.jobs set status = 'completed', completed_at = now() - interval '4 days'
  where id = j;

  begin
    perform public.claim_manual_follow_up(opted);
    threw := null;
  exception when others then
    threw := SQLERRM;
  end;
  perform pg_temp.chk(
    'THE POINT: "send now" refuses an unsubscribed customer rather than texting them',
    threw is not null and threw like '%review requests%', coalesce(threw, 'did not refuse'));

  -- Nothing on file at all.
  select id into cust from public.customers where name = 'Nora Nothing';
  begin
    perform public.claim_manual_follow_up(cust);
    threw := null;
  exception when others then
    threw := SQLERRM;
  end;
  perform pg_temp.chk('and says plainly when there is nothing to send to',
    threw like '%No email address or mobile number%', coalesce(threw, 'did not refuse'));
end $$;

-- ---------------------------------------------------------------------------
-- 8. The dedupe key, after being rebuilt
-- ---------------------------------------------------------------------------
--
-- Rebuilding a generated column means retyping every case. This is the check
-- that nothing was dropped on the way through — and the review case is the
-- least important of the four to get right, because the other three were
-- already working.

do $$
declare
  cust   uuid;
  j      uuid;
  q      uuid;
  first_ok  boolean;
  second_ok boolean;
  why    text;
begin
  select id into cust from public.customers where name = 'Phil Phone';
  select id into j from public.jobs where customer_id = cust;

  -- Outside quiet hours is not guaranteed while the tests run, so force.
  -- The dedupe index does not care either way.
  select ok into first_ok from public.claim_sms(
    'review', '5415550102', 'first', null, cust, null, j, null, true);
  select ok, reason into second_ok, why from public.claim_sms(
    'review', '5415550102', 'second', null, cust, null, j, null, true);

  perform pg_temp.chk('the first review text for a job is claimed', first_ok);
  perform pg_temp.chk('THE POINT: the second one for the same job is refused by the index',
    not second_ok, 'reason ' || coalesce(why, '(null)'));

  -- And the cases that were already there.
  insert into public.quotes (token, customer_id, customer_name, amount)
  values ('tok-dedupe', cust, 'Phil Phone', 400) returning id into q;

  select ok into first_ok from public.claim_sms(
    'quote', '5415550102', 'quote one', null, cust, q, null, null, true);
  select ok into second_ok from public.claim_sms(
    'quote', '5415550102', 'quote two', null, cust, q, null, null, true);

  perform pg_temp.chk(
    'THE POINT: rebuilding the column did not stop quotes deduplicating',
    first_ok and not second_ok,
    'a case left out of the rebuild breaks a feature nobody was changing');

  select ok into first_ok from public.claim_sms(
    'reminder', '5415550102', 'tomorrow', null, cust, null, j, null, true);
  select ok into second_ok from public.claim_sms(
    'reminder', '5415550102', 'tomorrow again', null, cust, null, j, null, true);
  perform pg_temp.chk('...nor reminders', first_ok and not second_ok);
end $$;

-- The index must still match claim_sms's ON CONFLICT clause exactly. If it
-- does not, every text the CRM sends fails outright — the failure db/lead-ack.sql
-- shipped once and this is the cheap way to never ship again.
do $$
declare
  pred text;
begin
  select pg_get_expr(i.indpred, i.indrelid) into pred
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'sms_messages_dedupe_idx';

  perform pg_temp.chk('THE POINT: the dedupe index still covers undelivered rows',
    pred like '%undelivered%', coalesce(pred, '(no index)'));
end $$;

-- ---------------------------------------------------------------------------
-- 9. Nobody is asked twice
-- ---------------------------------------------------------------------------

do $$
declare
  cust uuid;
  j1   uuid;
  j2   uuid;
  n    int;
begin
  -- Two jobs for one customer, completed the same day — two properties, or a
  -- one-off alongside a plan visit. One review request between them.
  insert into public.customers (name, email, phone)
  values ('Trish Twice', null, '5415550177') returning id into cust;

  insert into public.jobs (customer_id, status, services, price)
    values (cust, 'scheduled', 'Windows', 300) returning id into j1;
  insert into public.jobs (customer_id, status, services, price)
    values (cust, 'scheduled', 'Gutters', 200) returning id into j2;
  update public.jobs set status = 'completed', completed_at = now() - interval '4 days'
  where id in (j1, j2);

  select count(*) into n from public.claim_follow_ups(25);
  perform pg_temp.chk(
    'THE POINT: two jobs the same day is still one text, not two minutes apart',
    n = 1, n || ' claimed for one customer');
end $$;

-- ---------------------------------------------------------------------------

do $$
begin
  raise notice '';
  raise notice 'all ok — review requests hold, by email and by text';
end $$;
