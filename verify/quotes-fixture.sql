-- verify/quotes-fixture.sql
--
-- The minimum of the real schema needed to exercise quotes end to end:
-- profiles, leads, lead_events with its actor-capturing trigger, and a
-- stand-in for the commission trigger that records who WOULD be paid.
--
-- Self-contained on purpose. A suite that only passes because a previous run
-- left rows behind is not a suite, and two of these have caught exactly that
-- before.

-- Supabase ships these; a bare Postgres doesn't, and the RLS grants at the
-- end of the migration reference them by name.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
    then create role authenticated; end if;
end $$;

create schema if not exists auth;

-- Overridden per-test to simulate a signed-in user; null = no session, which
-- is the state a customer accepting a quote is in.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;

drop table if exists commissions, lead_events, leads, customers, profiles cascade;

create table profiles (
  id uuid primary key,
  full_name text,
  role text default 'tech',
  commission_book_rate numeric
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  address text,
  status text not null default 'new',
  estimate numeric
);

create table lead_events (
  id bigserial primary key,
  lead_id uuid references leads(id) on delete cascade,
  from_status text,
  to_status text,
  changed_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Stands in for sb_commission_on_lead_event. The real one is 120 lines of
-- rate lookup; what these tests need to know is only WHO the booking fee
-- would be attributed to, which is the thing the accept path can get wrong.
create table commissions (
  id bigserial primary key,
  lead_id uuid,
  profile_id uuid,
  kind text,
  base_amount numeric
);

create or replace function sb_commission_on_lead_event() returns trigger
language plpgsql as $$
begin
  if new.to_status = 'booked' and new.changed_by is not null then
    insert into commissions (lead_id, profile_id, kind, base_amount)
    select new.lead_id, new.changed_by, 'book', l.estimate
      from leads l where l.id = new.lead_id;
  end if;
  return new;
end;
$$;

create trigger commissions_lead_event after insert on lead_events
  for each row execute function sb_commission_on_lead_event();

-- The ORIGINAL log_lead_status_change, exactly as lead-events.sql installs
-- it, plus its trigger. db/quotes.sql then CREATE OR REPLACEs the function —
-- so this fixture also proves the migration upgrades an existing install in
-- place rather than needing the trigger rebuilt.
create or replace function log_lead_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor uuid;
begin
  select p.id into actor from profiles p where p.id = auth.uid();
  if tg_op = 'INSERT' then
    insert into lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, actor);
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, actor);
  end if;
  return new;
end;
$$;

create trigger leads_status_change
  after insert or update of status on leads
  for each row execute function log_lead_status_change();
