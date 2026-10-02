-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it.
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
      'runs against a scratch database built by verify/invoice-truth-fixture.sql, '
      'which creates public._scratch_db. If you meant to apply a migration, '
      'the file you want is in db/.';
  end if;
end $$;

-- Assertions for db/invoice-truth.sql.
--
-- Run against a THROWAWAY Postgres:
--   psql -d scratch -f verify/invoice-truth-fixture.sql
--   psql -d scratch -f db/job-events.sql
--   psql -d scratch -f db/invoice-truth.sql
--   psql -d scratch -f verify/invoice-truth.sql
--
-- What this is actually checking
-- ------------------------------
-- One thing above all others: THE HISTORY MUST NOT CLAIM SOMETHING WAS SENT
-- TO A CUSTOMER UNLESS IT WAS.
--
-- job_events is what gets read out when somebody says "you never sent me
-- that". A record that invents sends is worse than no record at all, because
-- it is believed. The old trigger inferred an email from a column changing,
-- so fixing that column by hand wrote three sends that never happened.
--
-- The assertions marked THE POINT are the ones that would notice if any of
-- that came back.

do $$
declare
  cust   uuid;
  job    uuid;
  paidjob uuid;
  n      int;
  s      text;
  s2     text;
  fresh  uuid;
  b      boolean;
  before int;
begin
  insert into public.customers (name) values ('Fixture Customer') returning id into cust;

  -- A completed job, NOT paid: the shape of one that was emailed an invoice.
  insert into public.jobs (customer_id, status, price, final_price, paid, payment_method)
  values (cust, 'completed', 3280, 3280, false, 'invoice')
  returning id into job;

  -- A completed job that HAS been paid, in cash. This is Jeff Krueger's job.
  insert into public.jobs (customer_id, status, price, final_price, paid, payment_method)
  values (cust, 'completed', 3280, 3280, true, 'cash')
  returning id into paidjob;

  -- Clear the events the inserts logged, so counts below start from zero.
  delete from public.job_events where job_id in (job, paidjob);

  -- =========================================================================
  -- A hand edit cannot claim an email was sent
  -- =========================================================================

  -- Exactly what happened on 30 Sep: somebody types the id into the Supabase
  -- table editor. No flag is set, because no code ran.
  update public.jobs set square_invoice_id = 'inv_ABC' where id = job;

  select count(*) into n from public.job_events where job_id = job and kind = 'invoice';
  assert n = 1, format('a hand edit should log one invoice event, got %s', n);
  raise notice 'ok    a hand edit is recorded';

  select detail into s from public.job_events where job_id = job and kind = 'invoice';
  assert s = 'Invoice recorded on the job',
    format('THE POINT: a hand edit must not claim an email. Got: %s', s);
  raise notice 'ok    THE POINT: a hand edit does NOT say it was emailed';

  select to_status into s from public.job_events where job_id = job and kind = 'invoice';
  assert s = 'inv_ABC', format('the invoice id should be on the event, got %s', s);
  raise notice 'ok    the invoice id is recorded on the event';

  -- =========================================================================
  -- Clearing the field and typing the same id back is not a second invoice
  -- =========================================================================
  --
  -- This is the one that made three rows out of one invoice. null -> 'abc'
  -- is a change, and the not-null guard only skips a write when the NEW
  -- value is null, so the old trigger logged the return trip too.

  update public.jobs set square_invoice_id = null  where id = job;
  update public.jobs set square_invoice_id = 'inv_ABC' where id = job;

  select count(*) into n from public.job_events where job_id = job and kind = 'invoice';
  assert n = 1,
    format('THE POINT: re-entering the same id must not log again, got %s rows', n);
  raise notice 'ok    THE POINT: clearing and re-entering the same id logs nothing';

  -- Saving the same value on top of itself is not a change at all.
  update public.jobs set square_invoice_id = 'inv_ABC' where id = job;
  select count(*) into n from public.job_events where job_id = job and kind = 'invoice';
  assert n = 1, format('re-saving an unchanged id should log nothing, got %s', n);
  raise notice 'ok    re-saving the same id logs nothing';

  -- A genuinely different invoice IS news and must still be recorded.
  update public.jobs set square_invoice_id = 'inv_XYZ' where id = job;
  select count(*) into n from public.job_events where job_id = job and kind = 'invoice';
  assert n = 2, format('a different invoice should log, got %s', n);
  raise notice 'ok    a genuinely different invoice is still recorded';

  select from_status into s
  from public.job_events
  where job_id = job and kind = 'invoice' and to_status = 'inv_XYZ';
  assert s = 'inv_ABC', format('the previous id should be on the event, got %s', s);
  raise notice 'ok    and it records which invoice it replaced';

  -- =========================================================================
  -- The one caller that MAY say it emailed
  -- =========================================================================

  delete from public.job_events where job_id in (job, paidjob);
  update public.jobs set square_invoice_id = null where id = job;

  perform public.record_invoice_on_job(job, 'inv_SENT', 'https://sq/i/1', 'UNPAID', true);

  select detail into s from public.job_events where job_id = job and kind = 'invoice';
  assert s = 'Invoice created and emailed to the customer',
    format('the sending path should say so. Got: %s', s);
  raise notice 'ok    the path that really sends says it emailed it';

  -- ... and the flag must not survive into the next write on this connection.
  update public.jobs set square_invoice_id = 'inv_AFTER' where id = job;
  select detail into s
  from public.job_events
  where job_id = job and kind = 'invoice' and to_status = 'inv_AFTER';
  assert s = 'Invoice recorded on the job',
    format('THE POINT: the emailed flag leaked into a later write. Got: %s', s);
  raise notice 'ok    THE POINT: the emailed flag does not leak to the next write';

  -- Recording one somebody sent from Square by hand: emailed => false.
  update public.jobs set square_invoice_id = null where id = job;
  perform public.record_invoice_on_job(job, 'inv_HAYDEN', null, null, false);
  select detail into s
  from public.job_events
  where job_id = job and kind = 'invoice' and to_status = 'inv_HAYDEN';
  assert s = 'Invoice recorded on the job',
    format('recording someone else''s send must not claim we emailed it. Got: %s', s);
  raise notice 'ok    recording an invoice Square already sent does not claim we sent it';

  -- =========================================================================
  -- Recording an invoice cannot un-pay a paid job
  -- =========================================================================
  --
  -- Jeff's job: paid in cash on the 29th, invoice recorded on the 30th. The
  -- old saveInvoiceOnJob wrote paid:false unconditionally, so the job then
  -- read "invoiced -- awaiting payment" on money already in the bank.

  select paid into b from public.jobs where id = paidjob;
  assert b, 'fixture should start paid';

  perform public.record_invoice_on_job(paidjob, 'inv_JEFF', 'https://sq/i/11', 'PAID', false);

  select paid into b from public.jobs where id = paidjob;
  assert b, 'THE POINT: recording an invoice must not un-pay a paid job';
  raise notice 'ok    THE POINT: recording an invoice leaves a paid job paid';

  -- And it must not invent a payment either.
  select count(*) into n from public.job_events where job_id = paidjob and kind = 'payment';
  assert n = 0, format('recording an invoice should log no payment, got %s', n);
  raise notice 'ok    and records no payment event';

  -- The other direction: an unpaid job stays unpaid.
  select paid into b from public.jobs where id = job;
  assert not b, 'THE POINT: recording an invoice must not mark a job paid';
  raise notice 'ok    THE POINT: recording an invoice does not mark a job paid';

  -- The invoice fields did land.
  select square_invoice_id into s from public.jobs where id = paidjob;
  assert s = 'inv_JEFF', format('the invoice id should be saved, got %s', s);
  select invoice_status into s from public.jobs where id = paidjob;
  assert s = 'PAID', format('the invoice status should be saved, got %s', s);
  raise notice 'ok    the invoice id and status are saved';

  -- A null url must not wipe the one already there.
  perform public.record_invoice_on_job(paidjob, 'inv_JEFF2', null, null, false);
  select invoice_url into s from public.jobs where id = paidjob;
  assert s = 'https://sq/i/11',
    format('a null url should leave the existing one alone, got %s', s);
  raise notice 'ok    a null url does not wipe the one on file';

  -- =========================================================================
  -- Correcting the payment method
  -- =========================================================================
  --
  -- Jeff's job: recorded as cash at completion, actually paid by ACH through
  -- a Square invoice. Square reports that ACH on the 1099-K, so the CRM
  -- saying cash is a real discrepancy in the books.

  select payment_method into s from public.jobs where id = paidjob;
  assert s = 'cash', format('fixture should start as cash, got %s', s);

  delete from public.job_events where job_id = paidjob;

  perform public.record_invoice_on_job(
    paidjob, 'inv_METHOD', null, null, false, 'square'
  );

  select payment_method into s from public.jobs where id = paidjob;
  assert s = 'square', format('the method should be corrected, got %s', s);
  raise notice 'ok    the payment method can be corrected';

  select count(*) into n
  from public.job_events where job_id = paidjob and kind = 'payment_method';
  assert n = 1,
    format('THE POINT: a correction must be recorded, not silent. Got %s rows', n);
  raise notice 'ok    THE POINT: and the correction is written into the history';

  select from_status, to_status into s, s2
  from public.job_events where job_id = paidjob and kind = 'payment_method';
  assert s = 'cash' and s2 = 'square',
    format('the correction should say what changed, got %s -> %s', s, s2);
  raise notice 'ok    and it says cash -> square';

  -- It must not look like a second payment.
  select count(*) into n
  from public.job_events where job_id = paidjob and kind = 'payment';
  assert n = 0,
    format('THE POINT: correcting a method is not a new payment. Got %s', n);
  raise notice 'ok    THE POINT: correcting a method logs no second payment';

  -- Null leaves it alone. This is the common case: recording an invoice
  -- without touching how the money came in.
  perform public.record_invoice_on_job(paidjob, 'inv_METHOD2', null, null, false, null);
  select payment_method into s from public.jobs where id = paidjob;
  assert s = 'square',
    format('a null method must leave the existing one alone, got %s', s);
  raise notice 'ok    a null payment method leaves it alone';

  -- So does a blank one, which is what an untouched form control sends.
  perform public.record_invoice_on_job(paidjob, 'inv_METHOD3', null, null, false, '  ');
  select payment_method into s from public.jobs where id = paidjob;
  assert s = 'square',
    format('THE POINT: a blank method must not wipe it, got %s', coalesce(s, 'null'));
  raise notice 'ok    THE POINT: and so does a blank one from an untouched form';

  -- THE JOB THAT ACTUALLY NEEDED THIS. Completed, invoiced through Square,
  -- and NOT paid -- a large ACH takes days to settle, so Square says UNPAID
  -- and the CRM agrees. The method still says cash, which was never true.
  -- The first version of this gated on paid and refused to record the fix on
  -- precisely this job.
  delete from public.job_events where job_id = job;
  update public.jobs set paid = false, payment_method = 'cash' where id = job;
  delete from public.job_events where job_id = job;

  update public.jobs set payment_method = 'square' where id = job;
  select count(*) into n
  from public.job_events where job_id = job and kind = 'payment_method';
  assert n = 1,
    format('THE POINT: a completed-but-unpaid job must still record the '
           'correction, got %s rows', n);
  raise notice 'ok    THE POINT: a completed job records it even before the money lands';

  -- But completing a job is not correcting one. The status and the method
  -- are written in the SAME update, so a rule reading new.status would log
  -- '(none) -> Cash' next to every single 'Job submitted'.
  insert into public.jobs (customer_id, status, price)
  values (cust, 'scheduled', 400)
  returning id into fresh;
  delete from public.job_events where job_id = fresh;

  update public.jobs
     set status = 'completed', paid = true, payment_method = 'cash'
   where id = fresh;

  select count(*) into n
  from public.job_events where job_id = fresh and kind = 'payment_method';
  assert n = 0,
    format('THE POINT: completing a job is not a correction, got %s rows', n);
  raise notice 'ok    THE POINT: and completing a job logs no correction';

  select count(*) into n
  from public.job_events where job_id = fresh and kind = 'completed';
  assert n = 1, format('completion should still log itself, got %s', n);
  raise notice 'ok    while the completion itself is still recorded';

  -- =========================================================================
  -- Refusals
  -- =========================================================================

  begin
    perform public.record_invoice_on_job(job, '   ', null, null, true);
    assert false, 'a blank invoice id should be refused';
  exception
    when others then
      assert sqlerrm like '%invoice id%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    a blank invoice id is refused';
  end;

  begin
    perform public.record_invoice_on_job(gen_random_uuid(), 'inv_NOPE', null, null, false);
    assert false, 'an unknown job should be refused';
  exception
    when others then
      raise notice 'ok    an unknown job is refused';
  end;

  -- =========================================================================
  -- Everything else the trigger does still works
  -- =========================================================================
  --
  -- The migration reproduces the whole 200-line function to change nine
  -- lines of it. These are the branches that would disappear quietly.

  before := (select count(*) from public.job_events where job_id = job);

  update public.jobs set status = 'cancelled' where id = job;
  select count(*) into n
  from public.job_events where job_id = job and kind = 'cancelled';
  assert n = 1, format('cancelling should still log, got %s', n);

  update public.jobs set starts_at = now() + interval '3 days' where id = job;
  select count(*) into n
  from public.job_events where job_id = job and kind = 'scheduled';
  assert n = 1, format('booking should still log, got %s', n);

  update public.jobs set starts_at = now() + interval '5 days' where id = job;
  select count(*) into n
  from public.job_events where job_id = job and kind = 'rescheduled';
  assert n = 1, format('rescheduling should still log, got %s', n);

  update public.jobs set property_type = 'commercial' where id = job;
  select count(*) into n
  from public.job_events where job_id = job and kind = 'property';
  assert n = 1, format('property change should still log, got %s', n);

  assert (select count(*) from public.job_events where job_id = job) > before,
    'the rest of the trigger stopped logging entirely';
  raise notice 'ok    the other branches of the trigger still log';

  -- Money arriving is still its own event.
  delete from public.job_events where job_id in (job, paidjob);
  update public.jobs set paid = true, payment_method = 'cash' where id = job;
  select count(*) into n from public.job_events where job_id = job and kind = 'payment';
  assert n = 1, format('a payment should still log, got %s', n);
  raise notice 'ok    a payment arriving is still recorded';

  raise notice '--- all assertions passed ---';
end $$;

-- ---------------------------------------------------------------------------
-- The cleanup, checked on rows the migration actually had to clean
-- ---------------------------------------------------------------------------
--
-- The duplicates were seeded by verify/invoice-truth-legacy.sql BEFORE
-- db/invoice-history-cleanup.sql ran, so what is asserted here is that
-- file's own DELETE -- not a copy of it pasted into this suite, which is
-- how the backfill went untested.

do $$
declare
  dup uuid := '44444444-4444-4444-4444-444444444444';
  two uuid := '66666666-6666-6666-6666-666666666666';
  n   int;
  s   text;
begin
  select count(*) into n from public.job_events where job_id = dup and kind = 'invoice';
  assert n = 1,
    format('THE POINT: three rows for one invoice should become one, got %s', n);
  raise notice 'ok    THE POINT: the duplicate invoice rows are removed';

  select detail into s from public.job_events where job_id = dup and kind = 'invoice';
  assert s = 'Invoice emailed to the customer',
    format('the kept row must be untouched, got %s', s);
  raise notice 'ok    and the one that is kept is left exactly as it was';

  select to_status into s from public.job_events where job_id = dup and kind = 'invoice';
  assert s = 'inv_A', format('the EARLIEST row should be the survivor, got %s', coalesce(s,'null'));
  raise notice 'ok    and it is the earliest one, not the last';

  select count(*) into n from public.job_events where job_id = two and kind = 'invoice';
  assert n = 2,
    format('THE POINT: two genuinely different invoices must both survive, got %s', n);
  raise notice 'ok    THE POINT: a job invoiced twice keeps both events';

  raise notice '--- all assertions passed ---';
end $$;

-- ---------------------------------------------------------------------------
-- The backfill, checked on a row that predates the migration
-- ---------------------------------------------------------------------------
--
-- The legacy job and its old-shaped event were seeded by
-- verify/invoice-truth-legacy.sql BEFORE db/invoice-truth.sql ran. So what
-- is asserted here is the migration's own backfill statement, not a copy of
-- it pasted into the test -- which is what the first version of this did,
-- leaving the suite green when the backfill was deleted outright.

do $$
declare
  job uuid := '22222222-2222-2222-2222-222222222222';
  s   text;
  n   int;
begin
  select to_status into s
  from public.job_events
  where job_id = job and kind = 'invoice';
  assert s = 'inv_LEGACY',
    format('THE POINT: the migration should have backfilled the id, got %s', coalesce(s, 'null'));
  raise notice 'ok    THE POINT: the migration backfilled an old invoice event';

  -- Which is the whole reason the backfill exists: without an id on the old
  -- event, the guard has nothing to match and the next write to this job
  -- logs a duplicate.
  update public.jobs set square_invoice_id = null       where id = job;
  update public.jobs set square_invoice_id = 'inv_LEGACY' where id = job;

  select count(*) into n from public.job_events where job_id = job and kind = 'invoice';
  assert n = 1,
    format('THE POINT: a backfilled event must stop the duplicate, got %s', n);
  raise notice 'ok    THE POINT: and that stops an old job logging a duplicate';

  -- The old wording is left alone. It may well have been true -- the CRM did
  -- email some of these -- and quietly rewriting history to make a migration
  -- tidy is its own version of the bug this file is about.
  select detail into s
  from public.job_events
  where job_id = job and kind = 'invoice';
  assert s = 'Invoice emailed to the customer',
    format('the backfill must not reword existing history, got %s', s);
  raise notice 'ok    and it does not reword what was already written';

  raise notice '--- all assertions passed ---';
end $$;
