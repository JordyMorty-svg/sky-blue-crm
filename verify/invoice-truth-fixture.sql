-- Fixture for verify/invoice-truth.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. The first statement drops tables.      #
-- #  It builds a throwaway stand-in for the real schema in a local Postgres  #
-- #  so db/job-events.sql and db/invoice-truth.sql can be exercised.         #
-- ############################################################################

drop table if exists
  public.job_events, public.jobs, public.customers, public.profiles
  cascade;

create extension if not exists pgcrypto;

create schema if not exists auth;

-- Stands in for Supabase's auth.uid(). Reads a session setting so a test can
-- say who it is -- and, crucially, so it can say NOBODY, which is what an
-- edit in the Supabase table editor looks like from in here.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.profiles (
  id        uuid primary key default gen_random_uuid(),
  full_name text
);

create table public.customers (
  id           uuid primary key default gen_random_uuid(),
  name         text,
  service_plan text
);

-- Only the columns the trigger actually reads, plus the invoice ones this
-- file is about. A smaller jobs table than production, on purpose: anything
-- extra here is a column whose absence from the trigger would go unnoticed.
create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid references public.customers (id) on delete set null,
  status            text,
  starts_at         timestamptz,
  completed_at      timestamptz,
  price             numeric(10, 2),
  final_price       numeric(10, 2),
  paid              boolean default false,
  payment_method    text,
  notes             text,
  receipt_url       text,
  square_invoice_id text,
  invoice_url       text,
  invoice_status    text,
  service_plan      text,
  property_type     text,
  is_extra          boolean default false
);

-- The marker every verify/*.sql checks for before it will run. Its absence
-- is what stops one of these files being pasted into Supabase by mistake.
create table if not exists public._scratch_db (created_at timestamptz default now());
insert into public._scratch_db default values;
