-- Sky Blue CRM — receipt and invoice links on jobs
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Square already generates a permanent, printable receipt for every card
-- payment and a downloadable PDF for every invoice. The CRM just wasn't
-- keeping the links: create-payment returns receipt_url, and nothing ever
-- wrote it down. This adds somewhere to put them so a completed job can
-- link straight to the document the customer received.
--
-- Cash and check jobs have no Square document — they get a receipt email
-- and nothing else. Their job record shows what was collected instead.

alter table public.jobs
  -- Square's hosted receipt page for a card payment. Public, permanent,
  -- and printable to PDF from the browser.
  add column if not exists receipt_url text,
  -- The 'Email invoice' path. These may already exist: invoiceService has
  -- been writing them since before there was a migration for them, which
  -- is exactly the kind of thing that fails silently.
  add column if not exists square_invoice_id text,
  add column if not exists invoice_url       text,
  add column if not exists invoice_status    text;

comment on column public.jobs.receipt_url is
  'Square hosted receipt for the card payment that settled this job.';
comment on column public.jobs.invoice_url is
  'Square hosted invoice page. Has a Download PDF button of its own.';

-- Say plainly whether the invoice columns were missing until now. If they
-- were, every "Email invoice" job completed so far recorded the payment
-- but lost the invoice link, and those jobs will show no invoice button.
do $$
declare
  jobs_with_invoice int;
  jobs_with_receipt int;
begin
  select count(*) into jobs_with_invoice
  from public.jobs where invoice_url is not null;

  select count(*) into jobs_with_receipt
  from public.jobs where receipt_url is not null;

  raise notice 'Jobs with an invoice link: %', jobs_with_invoice;
  raise notice 'Jobs with a receipt link:  % (0 is expected — nothing saved them until now)',
    jobs_with_receipt;
end;
$$;

-- Every completed job and what document, if any, is on file for it.
select
  c.name as customer,
  j.starts_at::date as job_date,
  j.payment_method,
  coalesce(j.final_price, j.price) as amount,
  case
    when j.receipt_url is not null then 'Square receipt'
    when j.invoice_url is not null then 'Square invoice'
    else 'none on file'
  end as document
from public.jobs j
left join public.customers c on c.id = j.customer_id
where j.status = 'completed'
order by j.starts_at desc nulls last;
