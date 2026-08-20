-- Sky Blue CRM — job history: what happened, when, and who did it
--
-- Run once in the Supabase SQL editor. Safe to re-run: every statement is
-- idempotent.
--
-- The same shape as lead_events, for the same reason: a job's status,
-- schedule, plan and payment are written from a dozen places (completeJob,
-- the card charge, the tap hand-off, the Square-return path, confirmVisit,
-- JobDetail, the customer profile, the re-date control) and more will
-- appear. A trigger can't be forgotten, and it catches edits made by hand in
-- the Supabase table editor too.
--
-- What this answers: "what actually happened with this job" — when it was
-- booked, every time it moved, the moment they went onto a plan, when it was
-- submitted, and when the money arrived. None of which `jobs` can tell you,
-- because it carries only the final state.

-- ---------------------------------------------------------------------------
-- 0. House timezone
-- ---------------------------------------------------------------------------

-- Dates in the history are rendered for a human in Oregon, not in UTC.
-- Without this a 6pm job reads as the following day, because Postgres
-- sessions run in UTC and to_char would happily say so.
--
-- Kept as a function rather than repeated as a literal so there is one place
-- to change it if Sky Blue ever works another timezone.
create or replace function public.sb_local(ts timestamptz)
returns timestamp
language sql
immutable
as $$ select ts at time zone 'America/Los_Angeles' $$;

comment on function public.sb_local(timestamptz) is
  'A timestamp as it reads in Oregon. Used for history wording only.';

-- ---------------------------------------------------------------------------
-- 1. When the job was completed
-- ---------------------------------------------------------------------------

-- A denormalised copy of the completion moment, so the common case — "show
-- me when this was submitted" — is a column read rather than a join.
alter table public.jobs
  add column if not exists completed_at timestamptz;

comment on column public.jobs.completed_at is
  'When the job was marked complete. Set by the trigger below; null for jobs
   completed before this migration, since that moment was never recorded.';

-- ---------------------------------------------------------------------------
-- 2. The events table
-- ---------------------------------------------------------------------------

create table if not exists public.job_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.jobs (id) on delete cascade,
  -- What happened. Deliberately text rather than an enum: a new kind of
  -- event shouldn't need a migration to record.
  --   created | scheduled | rescheduled | plan | property | price
  --   completed | payment | invoice | cancelled | status
  kind        text not null,
  -- Generic "what it was" / "what it became". Named for status because that
  -- was the first thing logged, but plan and property events use the same
  -- two columns for their own before/after values. The app decides how to
  -- label them, so adding a new kind needs no migration.
  from_status text,
  to_status   text,
  -- The money side, captured at the moment it happened rather than read
  -- back from the job later — a job can be re-dated or re-priced, and the
  -- history should still say what was true at the time.
  payment_method text,
  amount         numeric(10, 2),
  detail         text,
  -- References profiles, not auth.users, so PostgREST can embed the actor's
  -- name: .select("*, actor:changed_by ( full_name )"). Same shape as
  -- lead_events.changed_by.
  changed_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Older runs of this file may predate the kinds above; nothing to alter,
-- since kind is free text by design.

-- Same repair as lead_events carries, in case an earlier run of this file
-- pointed changed_by at auth.users — the actor's name can't be joined then.
do $$
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class fref on fref.oid = con.confrelid
    join pg_namespace fns on fns.oid = fref.relnamespace
    where rel.relname = 'job_events'
      and con.contype = 'f'
      and fns.nspname = 'auth'
      and fref.relname = 'users'
  ) then
    alter table public.job_events drop constraint if exists job_events_changed_by_fkey;
    alter table public.job_events
      add constraint job_events_changed_by_fkey
      foreign key (changed_by) references public.profiles (id) on delete set null;
    raise notice 'Repointed job_events.changed_by at public.profiles.';
  end if;
end;
$$;

-- The only query this table serves: history for one job, oldest first.
create index if not exists job_events_job_id_created_at_idx
  on public.job_events (job_id, created_at);

comment on table public.job_events is
  'Append-only history of a job: schedule, plan, status and payment changes.
   Written by triggers on jobs and customers.';
comment on column public.job_events.from_status is
  'Previous value. Status for status events, plan key for plan events, and
   so on — read it alongside kind.';

-- ---------------------------------------------------------------------------
-- 3. Stamping the completion moment
-- ---------------------------------------------------------------------------

-- This has to happen BEFORE the write — a trigger can only change the row on
-- its way in. Logging has to happen AFTER, because a job_events row
-- references the job, and on INSERT the job doesn't exist yet. One function
-- can't be both, so there are two.
create or replace function public.stamp_job_completed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status = 'completed' then
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_stamp_completed on public.jobs;

create trigger jobs_stamp_completed
  before update on public.jobs
  for each row
  execute function public.stamp_job_completed_at();

-- ---------------------------------------------------------------------------
-- 4. Logging what happened to the job
-- ---------------------------------------------------------------------------

create or replace function public.log_job_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
  moved text;
  first_schedule boolean;
  cust_plan text;
begin
  -- Resolve the acting user, but only if they have a profiles row. A raw
  -- auth.uid() with no matching profile would violate the foreign key and
  -- block the update itself — recording history must never be able to stop
  -- a payment being saved. Null just means "actor unknown", which is also
  -- what an edit in the Supabase table editor produces.
  select p.id into actor from public.profiles p where p.id = auth.uid();

  if tg_op = 'INSERT' then
    -- A job created straight onto the calendar is "booked". A job created
    -- from a lead with no date yet is only "added" — it lands in the
    -- To schedule list and gets a real date later, which is its own event.
    insert into public.job_events (
      job_id, kind, to_status, amount, detail, changed_by
    )
    values (
      new.id,
      case when new.starts_at is null then 'created' else 'scheduled' end,
      new.status,
      new.price,
      case
        when new.starts_at is null then null
        else to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY "at" FMHH12:MI AM')
      end,
      actor
    );
    return new;
  end if;

  -- Everything below here is UPDATE only, so OLD is safe to read.
  --
  -- A job leaving the To schedule list gets a date and a status in the same
  -- write. That is one action, so it gets one event -- the 'scheduled' one
  -- further down, which carries the date. Without this flag the history
  -- would say "Status changed" and "Booked" back to back for one click.
  first_schedule := old.starts_at is null and new.starts_at is not null;

  -- --- completion -------------------------------------------------------
  -- The event this whole table exists for. Recorded with the money as it
  -- stood at that moment, not as it stands now.
  if new.status is distinct from old.status and new.status = 'completed' then
    insert into public.job_events (
      job_id, kind, from_status, to_status, payment_method, amount, changed_by
    )
    values (
      new.id, 'completed', old.status, new.status,
      new.payment_method, coalesce(new.final_price, new.price), actor
    );

  -- --- any other status move -------------------------------------------
  elsif new.status is distinct from old.status
        and not (first_schedule and new.status = 'scheduled') then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    values (
      new.id,
      case when new.status = 'cancelled' then 'cancelled' else 'status' end,
      old.status, new.status, actor
    );
  end if;

  -- --- money arriving ---------------------------------------------------
  -- Separate from completion on purpose: an emailed invoice completes the
  -- job on one day and is paid on another, and those are two different
  -- facts. This is the row that records the second one.
  if coalesce(new.paid, false) is distinct from coalesce(old.paid, false)
     and coalesce(new.paid, false) then
    insert into public.job_events (
      job_id, kind, payment_method, amount, detail, changed_by
    )
    values (
      new.id, 'payment', new.payment_method,
      coalesce(new.final_price, new.price),
      case
        when new.receipt_url is not null then 'Card payment, receipt on file'
        when new.square_invoice_id is not null then 'Invoice paid in Square'
        else null
      end,
      actor
    );
  end if;

  -- --- an invoice going out ---------------------------------------------
  if new.square_invoice_id is not null
     and old.square_invoice_id is distinct from new.square_invoice_id then
    insert into public.job_events (job_id, kind, amount, detail, changed_by)
    values (
      new.id, 'invoice', coalesce(new.final_price, new.price),
      'Invoice emailed to the customer', actor
    );
  end if;

  -- --- the schedule moving ----------------------------------------------
  -- Logged at every status, not just after completion. A job that was
  -- pushed twice before it happened is exactly the thing worth being able
  -- to look up later — "did we move this, or did they?" — and the answer
  -- is unrecoverable if it isn't written down at the time.
  --
  -- Getting a date for the first time is not a move; it's the booking.
  if new.starts_at is distinct from old.starts_at then
    if old.starts_at is null then
      insert into public.job_events (job_id, kind, detail, changed_by)
      values (
        new.id, 'scheduled',
        to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY "at" FMHH12:MI AM'),
        actor
      );
    elsif new.starts_at is null then
      insert into public.job_events (job_id, kind, detail, changed_by)
      values (new.id, 'rescheduled', 'Taken off the calendar', actor);
    else
      -- Same-day nudges say the time; real moves say the date. Showing
      -- "Aug 25 to Aug 25" for a two-hour shift reads like a bug.
      if public.sb_local(old.starts_at)::date = public.sb_local(new.starts_at)::date then
        moved := 'Moved from ' || to_char(public.sb_local(old.starts_at), 'FMHH12:MI AM')
                 || ' to ' || to_char(public.sb_local(new.starts_at), 'FMHH12:MI AM');
      else
        moved := 'Moved from ' || to_char(public.sb_local(old.starts_at), 'FMMon FMDD')
                 || ' to ' || to_char(public.sb_local(new.starts_at), 'FMMon FMDD, YYYY');
      end if;

      insert into public.job_events (job_id, kind, detail, changed_by)
      values (new.id, 'rescheduled', moved, actor);
    end if;
  end if;

  -- --- the plan, changed on a job screen --------------------------------
  -- setJobPlan writes here. The customer profile writes to customers
  -- instead, which is why there is a second trigger further down.
  --
  -- ONE ACTION, TWO WRITES. Putting someone on a plan calls
  -- applyPlanFromJob (updates customers) and then setJobPlan (updates this
  -- job) back to back. Both fire a trigger, so the history showed
  -- "One-time -> Quarterly" twice, one second apart, on the same job.
  --
  -- The customer-level change is the real news: it's the commitment, and
  -- the customers trigger already attaches it to every job it affects.
  -- Stamping the job afterwards is bookkeeping — the job catching up to
  -- what the customer already is. So only log here when the job's new plan
  -- DIFFERS from the customer's, which is the case where the job genuinely
  -- diverges and nothing else would have recorded it.
  --
  -- Order matters and is relied on: every caller updates the customer
  -- first, so by the time this runs the customer already reads 'quarterly'.
  -- A job with no customer (lead-only) finds nothing, cust_plan stays null,
  -- and the event is logged — correctly, since there's no customer record
  -- that could have logged it instead.
  if coalesce(new.service_plan, 'one_time')
     is distinct from coalesce(old.service_plan, 'one_time') then

    select c.service_plan into cust_plan
    from public.customers c
    where c.id = new.customer_id;

    if coalesce(new.service_plan, 'one_time')
       is distinct from coalesce(cust_plan, '') then
      insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
      values (
        new.id, 'plan',
        coalesce(old.service_plan, 'one_time'),
        coalesce(new.service_plan, 'one_time'),
        actor
      );
    end if;
  end if;

  if coalesce(new.property_type, 'residential')
     is distinct from coalesce(old.property_type, 'residential') then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    values (
      new.id, 'property',
      coalesce(old.property_type, 'residential'),
      coalesce(new.property_type, 'residential'),
      actor
    );
  end if;

  -- --- the quote changing -----------------------------------------------
  -- Only before the job is done. Afterwards the number that matters is
  -- final_price, and that is already carried on the completion event.
  if new.price is distinct from old.price
     and coalesce(old.status, '') <> 'completed' then
    insert into public.job_events (job_id, kind, amount, detail, changed_by)
    values (
      new.id, 'price', new.price,
      'Quote was $' || to_char(coalesce(old.price, 0), 'FM999999.00'),
      actor
    );
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_event_log on public.jobs;

-- AFTER, not BEFORE. job_events.job_id references jobs, so on INSERT the row
-- has to exist before its first event can be written — a BEFORE trigger here
-- fails the foreign key and takes the whole job creation down with it.
create trigger jobs_event_log
  after insert or update on public.jobs
  for each row
  execute function public.log_job_event();

-- ---------------------------------------------------------------------------
-- 5. Plan changes made on the customer profile
-- ---------------------------------------------------------------------------

-- The plan lives on `customers`, not on `jobs`. Upgrading someone to
-- Quarterly from their profile — which is how it actually happens — never
-- touches the jobs table, so the trigger above would never see it. That is
-- the whole reason this second trigger exists.
--
-- Which jobs does a customer-level change belong to?
--
--   * every job still in flight, because the plan now governs it; and
--   * their most recently completed job, because that is the visit they
--     were standing on when they said yes. Attaching only to open jobs
--     would lose the event entirely in the common case — the upgrade is
--     usually made right after a job is marked complete, before the next
--     visit has been created.
--
-- The same event landing on two jobs is not duplication: "at this point in
-- this job's life, they went Quarterly" is independently true of each.
create or replace function public.log_customer_plan_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor        uuid;
  plan_changed boolean;
  type_changed boolean;
  recent       uuid;
begin
  plan_changed := coalesce(new.service_plan, 'one_time')
                  is distinct from coalesce(old.service_plan, 'one_time');
  type_changed := coalesce(new.property_type, 'residential')
                  is distinct from coalesce(old.property_type, 'residential');

  -- Saving the customer form rewrites every column. Without this guard,
  -- correcting a phone number would stamp a plan event on every open job.
  if not plan_changed and not type_changed then
    return new;
  end if;

  select p.id into actor from public.profiles p where p.id = auth.uid();

  -- The visit they were on when they signed up.
  select j.id into recent
  from public.jobs j
  where j.customer_id = new.id
    and j.status = 'completed'
  order by coalesce(j.completed_at, j.starts_at) desc nulls last
  limit 1;

  if plan_changed then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    select j.id, 'plan',
           coalesce(old.service_plan, 'one_time'),
           coalesce(new.service_plan, 'one_time'),
           actor
    from public.jobs j
    where j.customer_id = new.id
      and (coalesce(j.status, '') not in ('completed', 'cancelled')
           or j.id = recent);
  end if;

  if type_changed then
    insert into public.job_events (job_id, kind, from_status, to_status, changed_by)
    select j.id, 'property',
           coalesce(old.property_type, 'residential'),
           coalesce(new.property_type, 'residential'),
           actor
    from public.jobs j
    where j.customer_id = new.id
      and (coalesce(j.status, '') not in ('completed', 'cancelled')
           or j.id = recent);
  end if;

  return new;
end;
$$;

drop trigger if exists customers_plan_change on public.customers;

create trigger customers_plan_change
  after update on public.customers
  for each row
  execute function public.log_customer_plan_change();

-- ---------------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------------

alter table public.job_events enable row level security;

drop policy if exists "job_events readable by authenticated" on public.job_events;
create policy "job_events readable by authenticated"
  on public.job_events for select
  to authenticated
  using (true);

-- No insert policy on purpose. The triggers are security definer so they
-- write regardless, and the log stays append-only from the app's point of
-- view.

-- ---------------------------------------------------------------------------
-- 7. Backfill
-- ---------------------------------------------------------------------------

-- Jobs completed before today have no recorded completion moment, and there
-- is no honest way to invent one — starts_at is when the work was done, not
-- when it was submitted, and they can be days apart.
--
-- So: seed one event per existing job carrying what IS known (the status and
-- the money), timestamped from starts_at, and mark it as an estimate in
-- `detail` so nothing on screen claims a precision it doesn't have.
insert into public.job_events (
  job_id, kind, to_status, payment_method, amount, detail, created_at
)
select
  j.id,
  case when j.status = 'completed' then 'completed' else 'scheduled' end,
  j.status,
  j.payment_method,
  coalesce(j.final_price, j.price),
  'Recorded before job history existed — time not known',
  j.starts_at
from public.jobs j
where j.starts_at is not null
  and not exists (select 1 from public.job_events e where e.job_id = j.id);

-- ---------------------------------------------------------------------------
-- 8. Clean up the double plan events
-- ---------------------------------------------------------------------------

-- One-time repair for rows written before the guard above existed: putting
-- a customer on a plan wrote the same "One-time -> Quarterly" twice, a
-- second apart, once from the customers trigger and once from the jobs one.
--
-- Only exact duplicates go: same job, same kind, same before AND after
-- value, within a minute of each other. The earliest is kept.
--
-- A minute rather than a few seconds because the two writes are separate
-- round trips to Supabase, and on a phone on mobile data they can land
-- further apart than they do on a desk.
--
-- Safe to re-run. For this to delete a genuine event you would have to
-- change a plan from A to B twice inside a minute with a change back to A
-- in between — and that middle event has different from/to values, so it is
-- never matched.
delete from public.job_events e
using public.job_events keep
where e.kind = 'plan'
  and keep.kind = 'plan'
  and keep.job_id = e.job_id
  and keep.from_status is not distinct from e.from_status
  and keep.to_status  is not distinct from e.to_status
  and keep.id < e.id
  and e.created_at - keep.created_at < interval '1 minute';

-- ---------------------------------------------------------------------------
-- 9. What you've got
-- ---------------------------------------------------------------------------

select
  c.name as customer,
  j.starts_at::date as job_date,
  j.status,
  j.completed_at,
  count(e.id) as events
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join public.job_events e on e.job_id = j.id
group by c.name, j.starts_at, j.status, j.completed_at, j.id
order by j.starts_at desc nulls last
limit 20;
