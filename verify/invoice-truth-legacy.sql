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
