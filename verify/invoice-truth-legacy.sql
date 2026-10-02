-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it.
\set ON_ERROR_STOP on

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

-- A job as it looked BEFORE db/invoice-truth.sql.
--
-- ############################################################################
-- #  Throwaway Postgres only. Run BETWEEN db/job-events.sql and              #
-- #  db/invoice-truth.sql:                                                   #
-- #                                                                          #
-- #    psql -f verify/invoice-truth-fixture.sql                              #
-- #    psql -f db/job-events.sql                                             #
-- #    psql -f verify/invoice-truth-legacy.sql   <-- here                    #
-- #    psql -f db/invoice-truth.sql                                          #
-- #    psql -f verify/invoice-truth.sql                                      #
-- ############################################################################
--
-- Why this file exists at all.
--
-- The migration ends with a backfill that writes the invoice id onto events
-- the old trigger left blank. The first version of the verify suite tested
-- that by PASTING THE SAME UPDATE into itself and checking the paste worked
-- -- so deleting the backfill from the migration entirely left the suite
-- green. It was testing a copy of the statement, not the statement.
--
-- That is the same mistake as stubbing the module under test, which is how
-- `rpc is not defined` reached production on 28 Sep.
--
-- So the legacy row is seeded here, before the migration runs, and the
-- migration's own backfill is what has to fix it.

insert into public.customers (id, name)
values ('11111111-1111-1111-1111-111111111111', 'Legacy Customer');

insert into public.jobs (id, customer_id, status, price, square_invoice_id)
values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'completed', 500, 'inv_LEGACY'
);

-- Clear what the INSERT trigger logged, so the only invoice event on this
-- job is the old-shaped one below.
delete from public.job_events
 where job_id = '22222222-2222-2222-2222-222222222222';

-- An event exactly as the OLD trigger wrote them: the claim that an email
-- went out, and no invoice id to tell one invoice from another.
insert into public.job_events (job_id, kind, amount, detail)
values (
  '22222222-2222-2222-2222-222222222222',
  'invoice', 500, 'Invoice emailed to the customer'
);

-- ---------------------------------------------------------------------------
-- Jeff Krueger's job, as the old trigger left it
-- ---------------------------------------------------------------------------
--
-- Three "Invoice sent" rows for one invoice, two of them sharing a timestamp
-- to the minute, written by the trigger firing on every change to
-- square_invoice_id -- including the field being cleared and the SAME id
-- typed back in.
--
-- Seeded here rather than inside verify/invoice-truth.sql so that
-- db/invoice-history-cleanup.sql is the thing being tested, not a copy of
-- its DELETE pasted into the suite. That mistake left the backfill untested
-- for an afternoon.

insert into public.customers (id, name)
values ('33333333-3333-3333-3333-333333333333', 'Duplicate Customer');

insert into public.jobs (id, customer_id, status, price, final_price, paid, payment_method)
values (
  '44444444-4444-4444-4444-444444444444',
  '33333333-3333-3333-3333-333333333333',
  'completed', 3280, 3280, true, 'cash'
);

delete from public.job_events
 where job_id = '44444444-4444-4444-4444-444444444444';

insert into public.job_events (job_id, kind, amount, detail, to_status, created_at)
values
  ('44444444-4444-4444-4444-444444444444', 'invoice', 3280,
   'Invoice emailed to the customer', 'inv_A', '2026-09-30 09:05'),
  ('44444444-4444-4444-4444-444444444444', 'invoice', 3280,
   'Invoice emailed to the customer', 'inv_A', '2026-09-30 09:05'),
  ('44444444-4444-4444-4444-444444444444', 'invoice', 3280,
   'Invoice emailed to the customer', null,    '2026-09-30 09:15');

-- And a job genuinely invoiced TWICE, under two different Square ids. Both
-- are real events. The cleanup must not touch this one.
insert into public.customers (id, name)
values ('55555555-5555-5555-5555-555555555555', 'Twice Customer');

insert into public.jobs (id, customer_id, status, price)
values (
  '66666666-6666-6666-6666-666666666666',
  '55555555-5555-5555-5555-555555555555',
  'completed', 500
);

delete from public.job_events
 where job_id = '66666666-6666-6666-6666-666666666666';

insert into public.job_events (job_id, kind, amount, to_status, created_at)
values
  ('66666666-6666-6666-6666-666666666666', 'invoice', 500, 'inv_FIRST',  '2026-09-01 10:00'),
  ('66666666-6666-6666-6666-666666666666', 'invoice', 500, 'inv_SECOND', '2026-09-20 10:00');
