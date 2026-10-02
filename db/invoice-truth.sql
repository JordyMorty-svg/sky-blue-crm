-- Sky Blue CRM -- an invoice event that tells the truth
--
-- Run once in the Supabase SQL editor, AFTER db/job-events.sql.
-- Safe to re-run. Plain SQL: no psql meta-commands, nothing to strip.
--
-- Two bugs, one invoice.
--
-- 1. THE HISTORY LIED. The jobs trigger logged 'Invoice emailed to the
--    customer' whenever square_invoice_id changed. Nothing about that
--    column changing means an email was sent -- and on 30 Sep, fixing the
--    column by hand in the table editor wrote that sentence three times
--    for an invoice the CRM had never sent at all.
--
-- 2. AN INVOICE COULD UN-PAY A PAID JOB. completeJob() marks every
--    completion paid:true, including an emailed invoice, which is by
--    definition not paid. saveInvoiceOnJob() then wrote paid:false to
--    correct it -- which was right on the completion path and wrong
--    everywhere else, because attaching an invoice to a job already paid
--    in cash marked it unpaid. The job then read 'awaiting payment' on
--    money already in the bank, which is exactly what sent somebody into
--    the table editor in the first place. Both bugs, one root.
--
--    Fixed at the source: completeJob() now sets paid from the method, and
--    recording an invoice does not touch paid at all. See
--    src/services/jobService.js and src/services/invoiceService.js.
--
-- Asserted by verify/invoice-truth.sql, which is mutation-tested: putting
-- either bug back makes it fail.

-- ---------------------------------------------------------------------------
-- 1. The trigger, with an honest invoice branch
-- ---------------------------------------------------------------------------
--
-- Reproduced in full because CREATE OR REPLACE needs the whole body. Only
-- the invoice branch differs from db/job-events.sql; this file is generated
-- from that one by build-invoice-truth.py so the other branches cannot drift.

create or replace function public.log_job_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
  moved text;
  first_schedule boolean;
  cust_plan text;
begin
  -- Resolve the acting user, but only if they have a profiles row. A raw
  -- auth.uid() with no matching profile would violate the foreign key and
  -- block the update itself — recording history must never be able to stop
  -- a payment being saved. Null just means "actor unknown", which is also
  -- what an edit in the Supabase table editor produces.
  select p.id into actor from public.profiles p where p.id = auth.uid();

  if tg_op = 'INSERT' then
    -- A job created straight onto the calendar is "booked". A job created
    -- from a lead with no date yet is only "added" — it lands in the
    -- To schedule list and gets a real date later, which is its own event.
    insert into public.job_events (
      job_id, kind, to_status, amount, detail, changed_by
    )
    values (
      new.id,
      case when new.starts_at is null then 'created' else 'scheduled' end,
      new.status,
      new.price,
      case
        when new.starts_at is null then null
        else to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY "at" FMHH12:MI AM')
      end,
      actor
    );
    return new;
  end if;

  -- Everything below here is UPDATE only, so OLD is safe to read.
  --
  -- A job leaving the To schedule list gets a date and a status in the same
  -- write. That is one action, so it gets one event -- the 'scheduled' one
  -- further down, which carries the date. Without this flag the history
  -- would say "Status changed" and "Booked" back to back for one click.
  first_schedule := old.starts_at is null and new.starts_at is not null;

  -- --- completion -------------------------------------------------------
  -- The event this whole table exists for. Recorded with the money as it
  -- stood at that moment, not as it stands now.
  if new.status is distinct from old.status and new.status = 'completed' then
    insert into public.job_events (
      job_id, kind, from_status, to_status, payment_method, amount, changed_by
    )
    values (
      new.id, 'completed', old.status, new.status,
      new.payment_method, coalesce(new.final_price, new.price), actor
    );

  -- --- any other status move -------------------------------------------
  elsif new.status is distinct from old.status
        and not (first_schedule and new.status = 'scheduled') then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    values (
      new.id,
      case when new.status = 'cancelled' then 'cancelled' else 'status' end,
      old.status, new.status, actor
    );
  end if;

  -- --- money arriving ---------------------------------------------------
  -- Separate from completion on purpose: an emailed invoice completes the
  -- job on one day and is paid on another, and those are two different
  -- facts. This is the row that records the second one.
  if coalesce(new.paid, false) is distinct from coalesce(old.paid, false)
     and coalesce(new.paid, false) then
    insert into public.job_events (
      job_id, kind, payment_method, amount, detail, changed_by
    )
    values (
      new.id, 'payment', new.payment_method,
      coalesce(new.final_price, new.price),
      case
        when new.receipt_url is not null then 'Card payment, receipt on file'
        when new.square_invoice_id is not null then 'Invoice paid in Square'
        else null
      end,
      actor
    );
  end if;

  -- --- an invoice, recorded on the job ----------------------------------
  --
  -- WHAT A TRIGGER CAN AND CANNOT KNOW.
  --
  -- It sees a column change. It does not see an email leave the building.
  --
  -- The old version wrote 'Invoice emailed to the customer' on nothing more
  -- than square_invoice_id being different. So correcting that column by
  -- hand in the Supabase table editor MANUFACTURED customer-communication
  -- history that never happened: three 'Invoice sent' rows on Jeff
  -- Krueger's job, for one invoice, which Hayden had sent from Square
  -- himself and the CRM had never touched.
  --
  -- job_events is the thing that answers 'you never sent me that'. It has
  -- to be true, and a record that invents sends is worse than no record,
  -- because it is trusted.
  --
  -- So the wording now depends on who did the writing.
  -- record_invoice_on_job() sets a transaction-local flag before its
  -- UPDATE, and only the path that genuinely creates and publishes a Square
  -- invoice passes emailed => true. Everything else -- a hand edit, a
  -- backfill, a restore, a fix at five past nine in the morning -- cannot
  -- set that flag and gets the neutral wording, which is the only thing
  -- that was actually observed.
  if new.square_invoice_id is not null
     and old.square_invoice_id is distinct from new.square_invoice_id
     -- Re-entering an id this job has already carried is not a new invoice.
     --
     -- Clearing the field and typing the same id back logged a SECOND row,
     -- because null -> 'abc' is a change and the not-null guard above only
     -- skips the write when the NEW value is null. That is how one invoice
     -- became three events. The id now lives on the event, so this can ask.
     and not exists (
       select 1
       from public.job_events e
       where e.job_id = new.id
         and e.kind = 'invoice'
         and e.to_status = new.square_invoice_id
     ) then
    insert into public.job_events (
      job_id, kind, from_status, to_status, amount, detail, changed_by
    )
    values (
      new.id, 'invoice',
      old.square_invoice_id, new.square_invoice_id,
      coalesce(new.final_price, new.price),
      case
        when current_setting('app.invoice_emailed', true) = 'yes'
          then 'Invoice created and emailed to the customer'
        else 'Invoice recorded on the job'
      end,
      actor
    );
  end if;

  -- --- the payment method, corrected ------------------------------------
  --
  -- Deliberately NOT folded into the 'payment' event above, and the reason
  -- matters.
  --
  -- That event snapshots payment_method at the moment the money was
  -- recorded, and the snapshot must never be rewritten: it is what was
  -- believed at the time, and the history is a record of beliefs as much as
  -- of facts. But a belief can be wrong. Jeff Krueger's job went in as
  -- 'cash' and was actually paid by ACH through a Square invoice -- which is
  -- what Square reports on the 1099-K. Quietly flipping the column would
  -- leave a 'payment' event saying cash and a jobs row saying square, with
  -- nothing on the page explaining how it got from one to the other.
  --
  -- So a correction is its own line. Only once the job has been paid:
  -- before that the method is still being chosen, and choosing is not
  -- correcting.
  if new.payment_method is distinct from old.payment_method
     and coalesce(new.paid, false)
     and coalesce(old.paid, false) then
    insert into public.job_events (
      job_id, kind, from_status, to_status, amount, changed_by
    )
    values (
      new.id, 'payment_method',
      old.payment_method, new.payment_method,
      coalesce(new.final_price, new.price), actor
    );
  end if;

  -- --- the schedule moving ----------------------------------------------
  -- Logged at every status, not just after completion. A job that was
  -- pushed twice before it happened is exactly the thing worth being able
  -- to look up later — "did we move this, or did they?" — and the answer
  -- is unrecoverable if it isn't written down at the time.
  --
  -- Getting a date for the first time is not a move; it's the booking.
  if new.starts_at is distinct from old.starts_at then
    if old.starts_at is null then
      insert into public.job_events (job_id, kind, detail, changed_by)
      values (
        new.id, 'scheduled',
        to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY "at" FMHH12:MI AM'),
        actor
      );
    elsif new.starts_at is null then
      insert into public.job_events (job_id, kind, detail, changed_by)
      values (new.id, 'rescheduled', 'Taken off the calendar', actor);
    else
      -- Same-day nudges say the time; real moves say the date. Showing
      -- "Aug 25 to Aug 25" for a two-hour shift reads like a bug.
      if public.sb_local(old.starts_at)::date = public.sb_local(new.starts_at)::date then
        moved := 'Moved from ' || to_char(public.sb_local(old.starts_at), 'FMHH12:MI AM')
                 || ' to ' || to_char(public.sb_local(new.starts_at), 'FMHH12:MI AM');
      else
        moved := 'Moved from ' || to_char(public.sb_local(old.starts_at), 'FMMon FMDD')
                 || ' to ' || to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY');
      end if;

      insert into public.job_events (job_id, kind, detail, changed_by)
      values (new.id, 'rescheduled', moved, actor);
    end if;
  end if;

  -- --- the plan, changed on a job screen --------------------------------
  -- setJobPlan writes here. The customer profile writes to customers
  -- instead, which is why there is a second trigger further down.
  --
  -- ONE ACTION, TWO WRITES. Putting someone on a plan calls
  -- applyPlanFromJob (updates customers) and then setJobPlan (updates this
  -- job) back to back. Both fire a trigger, so the history showed
  -- "One-time -> Quarterly" twice, one second apart, on the same job.
  --
  -- The customer-level change is the real news: it's the commitment, and
  -- the customers trigger already attaches it to every job it affects.
  -- Stamping the job afterwards is bookkeeping — the job catching up to
  -- what the customer already is. So only log here when the job's new plan
  -- DIFFERS from the customer's, which is the case where the job genuinely
  -- diverges and nothing else would have recorded it.
  --
  -- Order matters and is relied on: every caller updates the customer
  -- first, so by the time this runs the customer already reads 'quarterly'.
  -- A job with no customer (lead-only) finds nothing, cust_plan stays null,
  -- and the event is logged — correctly, since there's no customer record
  -- that could have logged it instead.
  if coalesce(new.service_plan, 'one_time')
     is distinct from coalesce(old.service_plan, 'one_time') then

    select c.service_plan into cust_plan
    from public.customers c
    where c.id = new.customer_id;

    if coalesce(new.service_plan, 'one_time')
       is distinct from coalesce(cust_plan, '') then
      insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
      values (
        new.id, 'plan',
        coalesce(old.service_plan, 'one_time'),
        coalesce(new.service_plan, 'one_time'),
        actor
      );
    end if;
  end if;

  if coalesce(new.property_type, 'residential')
     is distinct from coalesce(old.property_type, 'residential') then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    values (
      new.id, 'property',
      coalesce(old.property_type, 'residential'),
      coalesce(new.property_type, 'residential'),
      actor
    );
  end if;

  -- --- the quote changing -----------------------------------------------
  -- Only before the job is done. Afterwards the number that matters is
  -- final_price, and that is already carried on the completion event.
  if new.price is distinct from old.price
     and coalesce(old.status, '') <> 'completed' then
    insert into public.job_events (job_id, kind, amount, detail, changed_by)
    values (
      new.id, 'price', new.price,
      'Quote was $' || to_char(coalesce(old.price, 0), 'FM999999.00'),
      actor
    );
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Recording an invoice, and saying honestly where it came from
-- ---------------------------------------------------------------------------
--
-- The ONLY writer that may claim an email was sent.
--
-- p_emailed is passed true by exactly one caller: the completion flow, which
-- has just created and published a Square invoice and therefore knows Square
-- emailed it. Recording an invoice somebody sent from Square by hand passes
-- false, and the history says so.
--
-- set_config(..., true) is transaction-local, and the flag is cleared again
-- the moment the write it describes is done. BOTH halves matter.
--
-- Transaction-local alone is not enough. A transaction can hold more than
-- one write, and the first draft of this left the flag standing: a second
-- jobs UPDATE in the same transaction inherited it and claimed an email
-- nobody sent, which is the exact bug this file exists to remove, moved one
-- step along. verify/invoice-truth.sql asserts it does not survive the
-- statement it was set for.
--
-- Without `true` it would be worse still: on a pooled connection the flag
-- would outlive the request and salt somebody else's write.
--
-- Note what this does NOT do: it never writes `paid`. An invoice is a
-- request for money, not money. Whether this job has been paid is a fact
-- that belongs to the payment, and recording paperwork about it must not be
-- able to change the answer.
-- DROPPED first, not CREATE OR REPLACE.
--
-- The signature is gaining p_payment_method. CREATE OR REPLACE with a new
-- argument list does not replace -- it creates an OVERLOAD, leaving two
-- functions of the same name, and PostgREST then has to guess which one a
-- call meant. Dropping the old signature by name is the only way to be sure
-- the five-argument version is gone.
drop function if exists public.record_invoice_on_job(uuid, text, text, text, boolean);

create or replace function public.record_invoice_on_job(
  p_job_id         uuid,
  p_invoice_id     text,
  p_url            text default null,
  p_status         text default null,
  p_emailed        boolean default false,
  -- Null means "leave it alone", which is the common case. Passing a value
  -- is how the Record-invoice screen fixes a job that went in as cash and
  -- was really paid through Square -- see the trigger branch above.
  p_payment_method text default null
)
returns table (
  out_job_id     uuid,
  out_paid       boolean,
  out_invoice_id text,
  out_status     text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_job_id is null or coalesce(btrim(p_invoice_id), '') = '' then
    raise exception 'A job and a Square invoice id are both needed to record an invoice.';
  end if;

  if p_emailed then
    perform set_config('app.invoice_emailed', 'yes', true);
  end if;

  return query
  update public.jobs j
     set square_invoice_id = btrim(p_invoice_id),
         invoice_url       = coalesce(p_url, j.invoice_url),
         invoice_status    = coalesce(p_status, j.invoice_status),
         payment_method    = coalesce(nullif(btrim(p_payment_method), ''), j.payment_method)
   where j.id = p_job_id
  returning j.id, j.paid, j.square_invoice_id, j.invoice_status;

  if not found then
    raise exception 'No job with id %', p_job_id;
  end if;

  -- Put it back down. The flag describes ONE write, not the rest of the
  -- transaction -- see the note above.
  perform set_config('app.invoice_emailed', '', true);
end;
$$;

comment on function public.record_invoice_on_job(uuid, text, text, text, boolean, text) is
  'Attach a Square invoice to a job. Pass p_emailed => true only when this
   call is what caused Square to email it. Never writes paid.';

revoke all on function public.record_invoice_on_job(uuid, text, text, text, boolean, text) from public;
grant execute on function public.record_invoice_on_job(uuid, text, text, text, boolean, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The id, written onto invoice events that predate this file
-- ---------------------------------------------------------------------------
--
-- The duplicate guard above matches on job_events.to_status, which older
-- invoice events do not carry. Without this, the first invoice recorded on
-- an existing job would log again -- the exact duplicate this file exists to
-- stop.
--
-- Only fills a blank. Never overwrites an id that is already there, so
-- re-running is free.
update public.job_events e
   set to_status = j.square_invoice_id
  from public.jobs j
 where e.job_id = j.id
   and e.kind = 'invoice'
   and e.to_status is null
   and j.square_invoice_id is not null;
