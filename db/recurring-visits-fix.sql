-- Sky Blue CRM — recurring visits that never got created
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Symptom: a customer is on Quarterly or BiAnnual, their first visit is
-- marked complete, and the customer profile shows no next visit at all.
--
-- Two causes, both fixed here:
--
--   1. jobs.status has a CHECK constraint written before recurring plans
--      existed, so it allows scheduled/completed/cancelled but NOT the
--      'upcoming' status a due-but-not-yet-booked visit uses. The insert
--      is rejected. completeJob catches that error on purpose — a failure
--      to book three months out must not roll back a payment already taken
--      — so the visit silently never appears.
--
--   2. The customer was put onto a plan AFTER their job was completed.
--      Nothing runs at that point, so visit 2 was never generated.
--
-- Section 1 reports and widens the constraint. Section 2 backfills the
-- visits that are missing. Section 3 shows what you ended up with.


-- ---------------------------------------------------------------------
-- 1. Make 'upcoming' a legal job status.
-- ---------------------------------------------------------------------
--
-- Rewrites any CHECK constraint on jobs.status to include 'upcoming',
-- keeping every value it already allowed. Does nothing if the column is
-- unconstrained (then this was never the problem — see section 2).

do $$
declare
  c record;
  found boolean := false;
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'jobs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    found := true;
    raise notice 'Found constraint % on public.jobs: %', c.conname, c.def;

    if c.def ilike '%upcoming%' then
      raise notice '  -> already allows ''upcoming'', leaving it alone.';
    else
      raise notice '  -> does NOT allow ''upcoming''. This is why no next visit was created.';
      execute format('alter table public.jobs drop constraint %I', c.conname);
      raise notice '  -> dropped; replacing below.';
    end if;
  end loop;

  if not found then
    raise notice 'No CHECK constraint on jobs.status — cause 1 ruled out, see section 2.';
  end if;
end;
$$;

-- Put back a constraint that covers every status the app actually writes.
-- 'upcoming' means due but not yet booked onto the schedule; it becomes
-- 'scheduled' when a crew is assigned.
do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'jobs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  ) then
    alter table public.jobs
      add constraint jobs_status_check
      check (status in ('scheduled', 'upcoming', 'completed', 'cancelled'));
    raise notice 'Added jobs_status_check allowing scheduled/upcoming/completed/cancelled.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Backfill the visits that should already exist.
-- ---------------------------------------------------------------------
--
-- For every customer on a plan whose latest visit is complete and who has
-- nothing due or booked, create the follow-up — same rules the app uses:
--
--   * counted forward from when the completed visit actually happened
--   * priced at what they paid, minus the plan discount for their tier
--     (visit 1 is always full price, so any backfilled visit is 2+)
--   * status 'upcoming', with no crew assigned
--
-- A visit completed before the customer signed up is stamped 'one_time'.
-- Putting them on a plan makes that visit their first plan visit, so it
-- gets stamped here too — otherwise the app refuses to count from it.

with recurring as (
  select id, service_plan, coalesce(property_type, 'residential') as property_type
  from public.customers
  where coalesce(service_plan, 'one_time') <> 'one_time'
),
-- Their most recent completed visit — the one the clock runs from.
last_done as (
  select distinct on (j.customer_id)
    j.id, j.customer_id, j.lead_id, j.services, j.duration_hours,
    j.starts_at, j.visit_number,
    coalesce(j.final_price, j.price, 0) as paid
  from public.jobs j
  join recurring r on r.id = j.customer_id
  where j.status = 'completed'
  order by j.customer_id, j.starts_at desc nulls last
),
-- Skip anyone who already has something due or booked.
needs_visit as (
  select d.*, r.service_plan, r.property_type
  from last_done d
  join recurring r on r.id = d.customer_id
  where not exists (
    select 1 from public.jobs p
    where p.customer_id = d.customer_id
      and p.status in ('upcoming', 'scheduled')
  )
)
insert into public.jobs (
  lead_id, customer_id, services, price, starts_at, duration_hours,
  status, service_plan, property_type, visit_number, previous_job_id
)
select
  n.lead_id,
  n.customer_id,
  n.services,
  greatest(
    0,
    n.paid - case
      when n.service_plan = 'quarterly' and n.property_type = 'commercial'  then 50
      when n.service_plan = 'quarterly'                                     then 100
      when n.service_plan = 'biannual'  and n.property_type = 'commercial'  then 25
      when n.service_plan = 'biannual'                                      then 50
      else 0
    end
  ),
  n.starts_at + case
    when n.service_plan = 'quarterly' then interval '3 months'
    else interval '6 months'
  end,
  n.duration_hours,
  'upcoming',
  n.service_plan,
  n.property_type,
  coalesce(n.visit_number, 1) + 1,
  n.id
from needs_visit n;

-- The completed visit they were signed up from is now their first plan
-- visit, so stamp it. Without this the app treats it as a one-off and
-- won't count the cycle from it next time.
update public.jobs j
set service_plan  = c.service_plan,
    property_type = coalesce(c.property_type, 'residential')
from public.customers c
where c.id = j.customer_id
  and coalesce(c.service_plan, 'one_time') <> 'one_time'
  and coalesce(j.service_plan, 'one_time') = 'one_time'
  and j.status = 'completed'
  and exists (
    select 1 from public.jobs n
    where n.previous_job_id = j.id
  );


-- ---------------------------------------------------------------------
-- 3. What every plan customer now looks like.
-- ---------------------------------------------------------------------

select
  c.name,
  c.service_plan,
  c.property_type,
  count(*) filter (where j.status = 'completed') as visits_done,
  max(j.starts_at) filter (where j.status = 'completed') as last_visit,
  max(j.starts_at) filter (where j.status = 'upcoming')  as next_due,
  max(j.starts_at) filter (where j.status = 'scheduled') as next_booked
from public.customers c
left join public.jobs j on j.customer_id = c.id
where coalesce(c.service_plan, 'one_time') <> 'one_time'
group by c.id, c.name, c.service_plan, c.property_type
order by c.name;
