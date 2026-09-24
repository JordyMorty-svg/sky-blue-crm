-- verify/rls-fixture.sql
--
-- The minimum of Supabase needed to exercise db/rls-phase-1.sql for real:
-- the anon and authenticated roles, an auth.uid() that can be pointed at a
-- test user, and the five tables the migration protects.
--
-- *** NEVER RUN THIS AGAINST SUPABASE. *** It drops tables.
--
-- Policies are the one thing that cannot be checked by reading. A policy
-- that looks right and a policy that works differ exactly when it matters,
-- so every assertion here CONNECTS AS the role in question and tries the
-- statement.

drop table if exists job_assignments, jobs, customers, leads, profiles cascade;

-- Supabase ships these; a bare Postgres does not.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
    then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;

-- Stands in for Supabase's auth.uid(), which reads the JWT. Tests set
-- `test.uid` to become somebody; leaving it unset is an anonymous caller.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table profiles (
  id                      uuid primary key,
  full_name               text,
  role                    text not null default 'tech',
  commission_eligible     boolean not null default true,
  commission_find_rate    numeric(5,2),
  commission_find_source  text,
  commission_book_rate    numeric(5,2),
  commission_work_rate    numeric(5,2)
);

create table leads (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  phone      text,
  status     text not null default 'new',
  source     text not null default 'website',
  estimate   numeric,
  created_by uuid references profiles(id)
);

create table customers (
  id    uuid primary key default gen_random_uuid(),
  name  text,
  phone text,
  email text
);

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  lead_id     uuid references leads(id),
  status      text not null default 'scheduled',
  price       numeric,
  final_price numeric
);

create table job_assignments (
  job_id  uuid references jobs(id) on delete cascade,
  tech_id uuid references profiles(id),
  primary key (job_id, tech_id)
);

-- Supabase grants these by default on everything in `public`. Granting them
-- here is what makes the test honest: it reproduces the situation the
-- migration exists to fix, where the only thing standing between the anon
-- key and every customer record is RLS.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
  on profiles, leads, customers, jobs, job_assignments
  to anon, authenticated;

-- Three people.
insert into profiles (id, full_name, role, commission_find_rate) values
  ('11111111-1111-1111-1111-111111111111', 'Jordan',  'admin',   null),
  ('22222222-2222-2222-2222-222222222222', 'Trenton', 'partner', 15),
  ('33333333-3333-3333-3333-333333333333', 'Hayden',  'tech',    null);

insert into customers (id, name, phone, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Meagan Dillon', '5415550134', 'm@example.com');

insert into leads (id, name, phone, status, estimate) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Jane O''Brien', '5415550199', 'quoted', 450);

insert into jobs (id, customer_id, status, price, final_price) values
  ('cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'completed', 250, 275);

insert into job_assignments (job_id, tech_id) values
  ('cccccccc-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333');

-- The token that lets verify/*.sql run at all. Nothing else creates this,
-- so a real database can never satisfy the guard at the top of those files.
create table if not exists public._scratch_db (created_at timestamptz default now());

