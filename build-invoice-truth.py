# Generates db/invoice-truth.sql from the current db/job-events.sql.
#
# The trigger function is 200 lines and CREATE OR REPLACE needs all of it.
# Retyping it by hand to change nine lines is how you ship a migration that
# silently drops the reschedule branch, so the new file is BUILT from the
# old one and the one branch being changed is asserted to exist verbatim
# first. If job-events.sql ever moves, this fails loudly instead of
# producing a half-correct function.

import re
import sys

src = open("db/job-events.sql", encoding="utf-8").read()

start = src.index("create or replace function public.log_job_event()")
end = src.index("$$;", src.index("return new;\nend;\n$$;", start)) + 3
fn = src[start:end]

OLD = """  -- --- an invoice going out ---------------------------------------------
  if new.square_invoice_id is not null
     and old.square_invoice_id is distinct from new.square_invoice_id then
    insert into public.job_events (job_id, kind, amount, detail, changed_by)
    values (
      new.id, 'invoice', coalesce(new.final_price, new.price),
      'Invoice emailed to the customer', actor
    );
  end if;"""

NEW = """  -- --- an invoice, recorded on the job ----------------------------------
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
  end if;"""

if OLD not in fn:
    sys.exit("REFUSING TO BUILD: the invoice branch in db/job-events.sql is not "
             "the text this script knows how to replace. Look at it by hand.")

fn_new = fn.replace(OLD, NEW)
assert fn_new != fn

# Everything the replacement must not have lost. If a future edit to this
# script mangles the function, these are the branches that would vanish
# quietly rather than error.
for marker in [
    "'completed'", "'cancelled'", "'rescheduled'", "'plan'", "'property'",
    "'price'", "'payment'", "first_schedule", "cust_plan", "sb_local",
]:
    assert marker in fn_new, f"lost {marker} from the trigger function"

HEADER = """-- Sky Blue CRM -- an invoice event that tells the truth
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

"""

RPC = """

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
create or replace function public.record_invoice_on_job(
  p_job_id     uuid,
  p_invoice_id text,
  p_url        text default null,
  p_status     text default null,
  p_emailed    boolean default false
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
         invoice_status    = coalesce(p_status, j.invoice_status)
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

comment on function public.record_invoice_on_job(uuid, text, text, text, boolean) is
  'Attach a Square invoice to a job. Pass p_emailed => true only when this
   call is what caused Square to email it. Never writes paid.';

revoke all on function public.record_invoice_on_job(uuid, text, text, text, boolean) from public;
grant execute on function public.record_invoice_on_job(uuid, text, text, text, boolean) to authenticated;
"""

BACKFILL = """

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
"""

out = HEADER + fn_new + "\n" + RPC + BACKFILL
open("db/invoice-truth.sql", "w", encoding="utf-8").write(out)
print(f"wrote db/invoice-truth.sql, {len(out)} chars")
