-- Sky Blue CRM -- removing the duplicate "Invoice sent" rows
--
-- Run ONCE in the Supabase SQL editor, AFTER db/invoice-truth.sql.
-- Safe to re-run: a second run finds nothing to do and says so.
-- Plain SQL. No psql meta-commands.
--
-- WHAT THIS DELETES, AND WHY DELETING IS THE HONEST OPTION
-- -------------------------------------------------------
-- On 30 Sep, Jeff Krueger's job grew three identical rows:
--
--   Invoice sent · $3,280 · Invoice emailed to the customer   09:05
--   Invoice sent · $3,280 · Invoice emailed to the customer   09:05
--   Invoice sent · $3,280 · Invoice emailed to the customer   09:15
--
-- There was one invoice. The extra rows are not a record of anything that
-- happened -- they are an artifact of the old trigger firing every time
-- square_invoice_id changed, including when the field was cleared and the
-- SAME id typed back in. (null -> 'abc' is a change, and the not-null guard
-- only skipped the write when the NEW value was null.)
--
-- Normally the right answer to bad history is to add a correcting row, not
-- to remove one -- that is why db/invoice-truth.sql leaves old wording
-- alone, and why a payment-method correction is its own event rather than
-- an edit. The difference here is that these rows assert an event that did
-- not occur. They are not a record that turned out to be wrong; they are a
-- record of nothing. Keeping them means job_events says this business sent
-- a customer three invoices it did not send, which is the exact failure
-- this whole area was fixed to prevent.
--
-- So: the EARLIEST invoice event per job is kept and left untouched. Only
-- later rows carrying the SAME invoice id -- or no id at all, which is what
-- the old trigger wrote -- are removed.

do $$
declare
  removed int;
begin
  with ranked as (
    select
      e.id,
      e.job_id,
      -- Oldest first. `id` breaks ties, because the first two of Jeff's
      -- three rows share a created_at to the minute and ordering on time
      -- alone would pick between them arbitrarily.
      row_number() over (
        partition by e.job_id
        order by e.created_at, e.id
      ) as seq,
      first_value(e.to_status) over (
        partition by e.job_id
        order by e.created_at, e.id
      ) as kept_invoice
    from public.job_events e
    where e.kind = 'invoice'
  )
  delete from public.job_events d
  using ranked r
  where d.id = r.id
    and r.seq > 1
    -- Only a row that is about the SAME invoice, or about no invoice at
    -- all. A job genuinely re-invoiced under a DIFFERENT Square id has two
    -- real events and keeps both.
    and (r.kept_invoice is null
         or d.to_status is null
         or d.to_status = r.kept_invoice);

  get diagnostics removed = row_count;

  if removed = 0 then
    raise notice 'Nothing to remove -- no duplicate invoice events found.';
  else
    raise notice 'Removed % duplicate invoice event(s). The first one on each job was kept.', removed;
  end if;
end $$;

-- What is left, so you can see it worked. Expect ONE row per job.
--
-- Joins `customers` only, not `leads`. A report at the end of a cleanup
-- script must not be able to fail on a schema that is missing an optional
-- table -- the DELETE above has already committed by then, and an error here
-- would make a successful run look like a broken one.
select
  j.id              as job_id,
  c.name            as customer,
  count(*)          as invoice_events,
  min(e.created_at) as first_recorded
from public.job_events e
join public.jobs j           on j.id = e.job_id
left join public.customers c on c.id = j.customer_id
where e.kind = 'invoice'
group by j.id, c.name
order by first_recorded desc;
