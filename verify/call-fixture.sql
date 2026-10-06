-- Fixture for verify/call-tracking.sql and verify/sms-thread.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. It drops tables. It builds a throwaway  #
-- #  stand-in for the real schema in a local Postgres so db/call-tracking.sql #
-- #  can be exercised. db/*.sql are the real migrations.                      #
-- ############################################################################
--
-- Runs AFTER verify/sms-fixture.sql, which already builds profiles,
-- customers, leads, jobs, quotes and contact_log. This adds the two event
-- tables contact_history.sql needs, which that fixture has no use for.
--
-- Without them db/contact-history.sql stops halfway through — after
-- contact_identity() and record_contact() exist but before
-- contact_timeline() does. Everything appears to work, which is the problem:
-- the mutation harness re-runs the migrations between mutants to put the
-- schema back, a half-applied restore leaves the previous mutant's changes
-- in place, and every later mutant is then killed by the wrong assertion.
-- A green run that means nothing.

do $$
begin
  if to_regclass('public.leads') is null then
    raise exception 'Run verify/sms-fixture.sql first — this file extends it.';
  end if;
end $$;

drop table if exists lead_events, job_events cascade;

create table lead_events (
  id          bigserial primary key,
  lead_id     uuid references leads (id) on delete cascade,
  kind        text default 'status',
  from_status text,
  to_status   text,
  changed_by  uuid references profiles (id),
  created_at  timestamptz not null default now()
);

create table job_events (
  id             bigserial primary key,
  job_id         uuid references jobs (id) on delete cascade,
  kind           text,
  from_status    text,
  to_status      text,
  amount         numeric,
  payment_method text,
  detail         text,
  changed_by     uuid references profiles (id),
  created_at     timestamptz not null default now()
);

-- Columns contact_timeline() reads off jobs for the "which visit was this?"
-- label. Added rather than assumed: the sms fixture's jobs table is the
-- minimum that db/sms.sql needed and has none of them.
alter table jobs
  add column if not exists starts_at     timestamptz,
  add column if not exists visit_number  int,
  add column if not exists service_plan  text,
  add column if not exists is_extra      boolean default false;

-- NOTHING HERE STUBS sent_emails OR email_unreachable, and the first
-- version of this file did both.
--
-- sms_messages.delivered_at — which the thread reads — is added by
-- db/delivery-controls.sql, and that file also touches the email side, so
-- it will not finish until those tables exist. Hand-written stand-ins for
-- them took four rounds of "add the column the next line wants" and were
-- still wrong, because a stub of a table is a guess about a table.
--
-- db/email-delivery.sql is in the chain instead. It is a real migration, it
-- is the thing that actually defines them, and it cannot drift from itself.

create table if not exists public._scratch_db (created_at timestamptz default now());
