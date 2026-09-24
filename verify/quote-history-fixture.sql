-- Fixture for verify/quote-history.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. The first statement drops tables.      #
-- ############################################################################

drop table if exists quotes, jobs, leads, customers, profiles cascade;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create extension if not exists pgcrypto;

create table profiles (
  id uuid primary key,
  full_name text
);

create table customers (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  phone      text,
  created_at timestamptz not null default now()
);

create table leads (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  phone      text,
  status     text not null default 'new',
  created_at timestamptz not null default now()
);

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads (id),
  customer_id uuid references customers (id),
  status      text not null default 'scheduled',
  starts_at   timestamptz
);

create table quotes (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique default encode(gen_random_bytes(32), 'hex'),
  lead_id       uuid references leads (id) on delete cascade,
  customer_id   uuid references customers (id) on delete cascade,
  customer_name text not null,
  address       text,
  service_keys  text[] not null default '{}',
  amount        numeric(10,2) not null,
  note          text,
  status        text not null default 'draft',
  sent_by       uuid references profiles (id),
  expires_at    timestamptz not null default now() + interval '30 days',
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  viewed_at     timestamptz,
  accepted_at   timestamptz
);

-- The real ones, from db/contact-history.sql. quotes_for_contact() is a thin
-- wrapper over contact_identity(), so the fixture has to carry the genuine
-- article or the test proves nothing about how they work together.
create or replace function public.sb_phone_digits(p text)
returns text language sql immutable
as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

create or replace function public.contact_identity(
  p_lead_id uuid default null, p_customer_id uuid default null
)
returns table (lead_ids uuid[], customer_ids uuid[], phone text)
language plpgsql stable security definer set search_path = public
as $$
declare
  ph text;
  leads_out uuid[] := '{}';
  customers_out uuid[] := '{}';
begin
  select sb_phone_digits(l.phone) into ph from public.leads l where l.id = p_lead_id;
  if ph is null then
    select sb_phone_digits(c.phone) into ph from public.customers c where c.id = p_customer_id;
  end if;

  select coalesce(array_agg(distinct id), '{}') into leads_out from (
    select l.id from public.leads l where l.id = p_lead_id
    union
    select l.id from public.leads l where ph is not null and sb_phone_digits(l.phone) = ph
    union
    select j.lead_id from public.jobs j
      where j.lead_id is not null
        and (j.customer_id = p_customer_id
             or j.lead_id = p_lead_id
             or j.customer_id in (select cc.id from public.customers cc
                                  where ph is not null and sb_phone_digits(cc.phone) = ph))
  ) s;

  select coalesce(array_agg(distinct id), '{}') into customers_out from (
    select c.id from public.customers c where c.id = p_customer_id
    union
    select c.id from public.customers c where ph is not null and sb_phone_digits(c.phone) = ph
    union
    select j.customer_id from public.jobs j
      where j.customer_id is not null
        and (j.lead_id = p_lead_id or j.lead_id = any(leads_out))
  ) s;

  return query select leads_out, customers_out, ph;
end;
$$;

insert into profiles (id, full_name) values
  ('11111111-1111-1111-1111-111111111111', 'Jordan Mortensen'),
  ('22222222-2222-2222-2222-222222222222', 'Hayden Mortensen');

-- The token that lets verify/*.sql run at all. Nothing else creates this,
-- so a real database can never satisfy the guard at the top of those files.
create table if not exists public._scratch_db (created_at timestamptz default now());

