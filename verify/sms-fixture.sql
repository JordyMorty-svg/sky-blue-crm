-- Fixture for verify/sms.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. The first statement drops tables.      #
-- #  It builds a throwaway stand-in for the real schema in a local Postgres  #
-- #  so db/sms.sql can be exercised. db/*.sql are the real migrations.       #
-- ############################################################################

drop table if exists
  sms_messages, sms_opt_outs, contact_log, quotes, jobs, leads, customers, profiles
  cascade;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

create extension if not exists pgcrypto;

create schema if not exists auth;

-- Stands in for Supabase's auth.uid(). Reads a session setting so a test can
-- say who it is.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table profiles (
  id         uuid primary key,
  full_name  text,
  created_at timestamptz not null default now()
);

create table customers (
  id                uuid primary key default gen_random_uuid(),
  name              text,
  phone             text,
  email             text,
  last_contacted_at timestamptz,
  contact_attempts  int not null default 0,
  created_at        timestamptz not null default now()
);

create table leads (
  id                uuid primary key default gen_random_uuid(),
  name              text,
  phone             text,
  email             text,
  status            text not null default 'new',
  estimate          numeric,
  last_contacted_at timestamptz,
  contact_attempts  int not null default 0,
  created_at        timestamptz not null default now()
);

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads (id),
  customer_id uuid references customers (id),
  status      text not null default 'scheduled',
  starts_at   timestamptz,
  price       numeric,
  created_at  timestamptz not null default now()
);

create table quotes (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  lead_id       uuid references leads (id),
  customer_id   uuid references customers (id),
  customer_name text,
  amount        numeric,
  status        text not null default 'sent',
  sent_at       timestamptz,
  viewed_at     timestamptz,
  accepted_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '30 days',
  created_at    timestamptz not null default now()
);

-- The real one, from db/contact-history.sql. Present so mark_sms_sent() and
-- record_inbound_sms() are proven to write history, not just outbox rows.
create table contact_log (
  id          bigint generated always as identity primary key,
  lead_id     uuid references leads (id)     on delete set null,
  customer_id uuid references customers (id) on delete set null,
  phone_norm  text,
  kind        text not null default 'call',
  from_status text,
  to_status   text,
  detail      text,
  changed_by  uuid references profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

insert into profiles (id, full_name) values
  ('11111111-1111-1111-1111-111111111111', 'Jordan Mortensen'),
  ('22222222-2222-2222-2222-222222222222', 'Hayden Mortensen');

-- The token that lets verify/*.sql run at all. Nothing else creates this,
-- so a real database can never satisfy the guard at the top of those files.
create table if not exists public._scratch_db (created_at timestamptz default now());

