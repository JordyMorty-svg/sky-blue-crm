-- Sky Blue CRM — card-on-file support
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is IF NOT EXISTS.

-- Customers: link to Square and remember one card on file.
alter table public.customers
  add column if not exists square_customer_id text,
  add column if not exists square_card_id     text,
  add column if not exists card_brand         text,
  add column if not exists card_last4         text,
  add column if not exists card_exp_month     int,
  add column if not exists card_exp_year      int;

-- Jobs: remember which Square payment settled this job.
alter table public.jobs
  add column if not exists square_payment_id text;

-- Looking a customer up by their Square id happens on every repeat charge.
create index if not exists customers_square_customer_id_idx
  on public.customers (square_customer_id);

comment on column public.customers.square_card_id is
  'Square card-on-file id (ccof:...). Used as source_id to charge repeat visits.';
comment on column public.customers.card_last4 is
  'Display only — last 4 digits so the CRM can show "Visa ****4242".';
