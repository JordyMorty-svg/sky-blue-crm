-- db/properties.sql — one customer, several addresses
--
-- WHY THIS EXISTS. A customer rang about a model home being remodelled —
-- nine windows, $395 — and then asked us to do the house they actually live
-- in. One person, one phone number, one invoice trail, two buildings. Until
-- now a job had no address of its own: every screen read it off the customer
-- or the lead, so booking the second property meant either editing the
-- customer's address (breaking the first job) or creating a duplicate
-- customer (breaking the history, the plan and the totals).
--
-- WHAT THIS ADDS
--
--   customer_properties  — the addresses one customer has. Exactly one is
--                          primary. Booking a job picks one.
--   jobs.property_id     — which building this visit is at.
--   jobs.address/lat/lng — the FROZEN address, written when the job is
--                          finished and never again.
--
-- THE TWO COLUMNS ARE NOT THE SAME THING and conflating them is the mistake
-- this file is shaped to prevent:
--
--   property_id is a POINTER. While a job is still ahead of us it follows
--     the property, so correcting a typo in an address corrects every
--     upcoming visit there. That is the whole value of normalising it.
--
--   address/latitude/longitude is a PHOTOGRAPH. The moment a job completes,
--     where it happened becomes a historical fact that nothing may edit. A
--     customer who moves house must not retroactively relocate the jobs we
--     already did, the invoices we already sent, or the mileage we already
--     claimed.
--
-- So: pointer while it is a plan, photograph once it is a fact.
--
-- PLANS ARE STILL ON THE CUSTOMER. See claude/crm-recurring-plans.md —
-- customers.service_plan is the commitment and jobs.service_plan is a stamp.
-- This file deliberately does NOT make plans property-aware. A customer on
-- Quarterly with two houses is a real situation and an unsolved one; it
-- needs a decision about whether that is one plan or two, and guessing here
-- would bake the wrong answer into the schema. Section 8 has a diagnostic
-- that lists any customer this already applies to.
--
-- Idempotent. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 0. Not the scratch database
-- ---------------------------------------------------------------------------
-- Same guard every migration in this repo carries. verify/*.sql drop tables;
-- db/*.sql must never be the file that ran somewhere it shouldn't have.

-- ---------------------------------------------------------------------------
-- 1. The coordinate columns this file assumes exist
-- ---------------------------------------------------------------------------
--
-- customers and leads are the two tables in this schema that predate db/ —
-- they were made in the Supabase dashboard, so no migration here describes
-- them and nothing proves what they contain. The app writes latitude and
-- longitude to both (AddressPicker in CustomerDetail, NewLead, AddLeadModal),
-- so they are there; "so they are there" is not a thing to bet a migration
-- on at eleven at night.
--
-- `if not exists` makes this free when they exist and correct when they
-- don't, which is cheaper than finding out from a half-applied migration.

alter table public.customers
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;

alter table public.leads
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;

-- ---------------------------------------------------------------------------
-- 2. The addresses a customer has
-- ---------------------------------------------------------------------------

create table if not exists public.customer_properties (
  id          uuid primary key default gen_random_uuid(),

  customer_id uuid not null references public.customers (id) on delete cascade,

  -- "Model home", "Main house", "Rental on 9th". Optional: most customers
  -- have one address and naming it is noise. It earns its place the moment
  -- there are two, which is exactly when somebody is choosing between them
  -- in a dropdown on a driveway.
  label       text,

  address     text not null,

  -- COORDINATES ARE THE POINT OF THE PICKER. A rural address on the edge of
  -- Corvallis is precisely where geocoding a string goes wrong, and
  -- navigation.js prefers coordinates for that reason. Nullable because a
  -- hand-typed address that never touched the autocomplete has none.
  latitude    double precision,
  longitude   double precision,

  -- Where to default to. Not "the first one" — the first one created is an
  -- accident of data entry, and for this customer it is the model home
  -- rather than the house they live in.
  is_primary  boolean not null default false,

  -- Archived rather than deleted: a property with finished jobs against it
  -- is history. Hiding it from the picker is the actual requirement.
  archived_at timestamptz,

  created_at  timestamptz not null default now()
);

-- EXACTLY ONE PRIMARY, enforced rather than maintained by the application.
-- Two screens can set a primary; only the database can be the one that
-- refuses the second. Partial, so archiving a property frees the slot and
-- so the constraint says nothing about customers with no primary at all
-- (which is what a customer with no address on file is).
create unique index if not exists customer_properties_one_primary
  on public.customer_properties (customer_id)
  where is_primary and archived_at is null;

create index if not exists customer_properties_customer_idx
  on public.customer_properties (customer_id, archived_at);

comment on table public.customer_properties is
  'The buildings one customer wants cleaned. One is primary; jobs point at
   one of these while they are still upcoming.';

-- ---------------------------------------------------------------------------
-- 3. A job knows which building it is at
-- ---------------------------------------------------------------------------

alter table public.jobs
  -- on delete set null, not cascade: deleting a property must never delete
  -- the record that we cleaned it and were paid for it. The frozen address
  -- below is what keeps a finished job readable afterwards.
  add column if not exists property_id uuid
    references public.customer_properties (id) on delete set null,

  -- THE PHOTOGRAPH. Null while the job is ahead of us. Written once, by the
  -- trigger in section 4, when the job is finished.
  add column if not exists address   text,
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;

create index if not exists jobs_property_idx on public.jobs (property_id);

comment on column public.jobs.address is
  'Where this job HAPPENED, frozen on completion. Null means the job is
   still upcoming — read sb_job_address() instead of this column.';

-- ---------------------------------------------------------------------------
-- 4. Where is this job, actually?
-- ---------------------------------------------------------------------------
--
-- ONE ANSWER, IN ONE PLACE. Before this file there were eleven places in the
-- app resolving a job's address by hand, and they did not agree: JobDetail
-- read `lead?.address || customer?.address` while JobRecord, ConfirmVisit
-- and taxService read `customer?.address || lead?.address`. For any customer
-- whose address had ever been corrected, two screens showed two different
-- addresses for the same job and neither looked wrong.
--
-- The order below is deliberate and the comments are the reasoning:

-- TWO FUNCTIONS, NOT ONE, and the split is the whole reason the freeze is
-- safe. _live answers "where is this building today" from the records that
-- are still maintained. sb_job_address puts the frozen photograph in front
-- of it. The trigger in the next section calls _live deliberately: if it
-- called the public one it would read the job's own frozen column back out
-- of the table and write it straight back, so the guard that stops a
-- re-completion moving the job would be doing nothing and no test could
-- tell. A condition nobody can make fail is a condition nobody can reason
-- about.

create or replace function public.sb_job_address_live(p_job_id uuid)
returns table (address text, latitude double precision, longitude double precision)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(
      -- 1. The property this visit was booked at.
      nullif(btrim(coalesce(p.address, '')), ''),
      -- 2. The customer record. The maintained one — a lead is a snapshot of
      --    what somebody typed into a form once, a customer is the row we
      --    actually keep correct.
      nullif(btrim(coalesce(c.address, '')), ''),
      -- 3. The lead. Last, and only because a job booked straight off a lead
      --    before the customer existed has nothing else.
      nullif(btrim(coalesce(l.address, '')), '')
    ),
    -- COORDINATES TRAVEL WITH THE ADDRESS THEY BELONG TO, not independently.
    -- Taking the street from the property and the pin from the customer
    -- sends the van to the wrong house with the right name on the screen,
    -- which is worse than having no pin at all.
    case
      when nullif(btrim(coalesce(p.address, '')), '') is not null then p.latitude
      when nullif(btrim(coalesce(c.address, '')), '') is not null then c.latitude
      else l.latitude
    end,
    case
      when nullif(btrim(coalesce(p.address, '')), '') is not null then p.longitude
      when nullif(btrim(coalesce(c.address, '')), '') is not null then c.longitude
      else l.longitude
    end
  from public.jobs j
  left join public.customer_properties p on p.id = j.property_id
  left join public.customers           c on c.id = j.customer_id
  left join public.leads               l on l.id = j.lead_id
  where j.id = p_job_id;
$$;

create or replace function public.sb_job_address(p_job_id uuid)
returns table (address text, latitude double precision, longitude double precision)
language sql
stable
security definer
set search_path = public
as $$
  select
    -- FROZEN FIRST. A finished job's address is a fact and outranks every
    -- live record, including a customer who has since moved house.
    coalesce(nullif(btrim(coalesce(j.address, '')), ''), live.address),
    case when nullif(btrim(coalesce(j.address, '')), '') is not null
         then j.latitude else live.latitude end,
    case when nullif(btrim(coalesce(j.address, '')), '') is not null
         then j.longitude else live.longitude end
  from public.jobs j
  cross join lateral public.sb_job_address_live(j.id) live
  where j.id = p_job_id;
$$;

comment on function public.sb_job_address(uuid) is
  'Where a job is: frozen address, else its property, else the customer,
   else the lead. Coordinates always come from the same row as the address.';

grant execute on function public.sb_job_address_live(uuid) to authenticated;
grant execute on function public.sb_job_address(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Freezing, when the work is done
-- ---------------------------------------------------------------------------

create or replace function public.sb_freeze_job_address()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  found_at record;
begin
  -- ALREADY FROZEN WINS. A job that is completed, reopened and completed
  -- again must keep the address it had the first time; the work happened
  -- where it happened. Re-freezing would quietly adopt whatever the customer
  -- record says today, which is the exact failure this column exists to stop.
  if nullif(btrim(coalesce(new.address, '')), '') is not null then
    return new;
  end if;

  select * into found_at from public.sb_job_address_live(new.id);

  new.address   := found_at.address;
  new.latitude  := found_at.latitude;
  new.longitude := found_at.longitude;

  return new;
end;
$$;

drop trigger if exists jobs_freeze_address on public.jobs;

-- BEFORE, not AFTER: assigning to NEW is how a BEFORE trigger writes, and
-- the same work in an AFTER trigger would need a second UPDATE that fires
-- the whole job-event chain again.
--
-- The WHEN clause rather than an `if` inside the function, so an ordinary
-- update to a scheduled job does not pay for a function call it will not use.
create trigger jobs_freeze_address
  before update on public.jobs
  for each row
  when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.sb_freeze_job_address();

-- ---------------------------------------------------------------------------
-- 6. Every customer's existing address becomes their primary property
-- ---------------------------------------------------------------------------
--
-- Without this the picker opens empty for everybody and the feature reads as
-- broken on day one.

insert into public.customer_properties (customer_id, address, latitude, longitude, is_primary)
select c.id, btrim(c.address), c.latitude, c.longitude, true
  from public.customers c
 where nullif(btrim(coalesce(c.address, '')), '') is not null
   -- Re-running must not make a second copy.
   and not exists (
     select 1 from public.customer_properties p
      where p.customer_id = c.id and p.archived_at is null
   );

-- ---------------------------------------------------------------------------
-- 7. History is frozen where it stands
-- ---------------------------------------------------------------------------
--
-- THE POINT OF DOING THIS NOW. Every completed job currently displays an
-- address resolved live from the customer. The first time somebody edits a
-- customer's address after this migration, all of that history would move
-- with it — silently, with no event logged and nothing to compare against.
--
-- Freezing them at today's value means the change this file makes is
-- invisible: every finished job keeps showing exactly what it showed
-- yesterday, forever.

-- The lateral call lives inside the subquery, with its own copy of jobs.
-- `from public.sb_job_address(j.id)` against the row being updated reads
-- naturally and is rejected: a FROM item cannot reference the UPDATE target.
update public.jobs j
   set address   = a.address,
       latitude  = a.latitude,
       longitude = a.longitude
  from (
    select x.id, f.address, f.latitude, f.longitude
      from public.jobs x
      cross join lateral public.sb_job_address(x.id) f
     where x.status = 'completed'
       and nullif(btrim(coalesce(x.address, '')), '') is null
  ) a
 where a.id = j.id
   and a.address is not null;

-- ---------------------------------------------------------------------------
-- 8. Upcoming jobs point at the primary property
-- ---------------------------------------------------------------------------
--
-- Not frozen — these are still plans, and a typo fixed on the property
-- should still reach them.

update public.jobs j
   set property_id = p.id
  from public.customer_properties p
 where p.customer_id = j.customer_id
   and p.is_primary
   and p.archived_at is null
   and j.property_id is null
   and j.status is distinct from 'completed';

-- ---------------------------------------------------------------------------
-- 9. Row level security
-- ---------------------------------------------------------------------------
-- Same shape as public.customers in db/rls-phase-1.sql: staff read and write,
-- admins delete.

alter table public.customer_properties enable row level security;

drop policy if exists customer_properties_staff_read on public.customer_properties;
create policy customer_properties_staff_read on public.customer_properties
  for select to authenticated using (true);

drop policy if exists customer_properties_staff_insert on public.customer_properties;
create policy customer_properties_staff_insert on public.customer_properties
  for insert to authenticated with check (true);

drop policy if exists customer_properties_staff_update on public.customer_properties;
create policy customer_properties_staff_update on public.customer_properties
  for update to authenticated using (true) with check (true);

drop policy if exists customer_properties_admin_delete on public.customer_properties;
create policy customer_properties_admin_delete on public.customer_properties
  for delete to authenticated using (public.sb_is_admin());

-- ---------------------------------------------------------------------------
-- 10. Diagnostic: who already has this problem?
-- ---------------------------------------------------------------------------
-- READ ONLY. Lists customers with more than one property, and flags the ones
-- also on a recurring plan — the unsolved case named at the top of this file.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select c.id, c.name, c.service_plan, count(p.id) as properties
      from public.customers c
      join public.customer_properties p
        on p.customer_id = c.id and p.archived_at is null
     group by c.id, c.name, c.service_plan
    having count(p.id) > 1
     order by c.name
  loop
    n := n + 1;
    raise notice '% — % properties%', r.name, r.properties,
      case when coalesce(r.service_plan, 'one_time') <> 'one_time'
           then ' — ON ' || upper(r.service_plan) || ': which house is the plan for?'
           else '' end;
  end loop;

  if n = 0 then
    raise notice 'No customer has more than one property yet.';
  end if;
end $$;
