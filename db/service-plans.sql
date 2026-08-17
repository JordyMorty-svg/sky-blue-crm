-- Sky Blue CRM — recurring service plans
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Three plans, and two discount tiers depending on the property:
--
--                    residential   commercial
--   one_time              --           --
--   biannual  (6 mo)     $50          $25
--   quarterly (3 mo)    $100          $50
--
-- The first clean is always full price. That's why jobs carry a
-- visit_number: the discount is a property of "which visit is this",
-- not of the customer. property_type picks the tier.

alter table public.leads
  add column if not exists service_plan  text not null default 'one_time',
  add column if not exists property_type text not null default 'residential';

alter table public.customers
  add column if not exists service_plan  text not null default 'one_time',
  add column if not exists property_type text not null default 'residential';

alter table public.jobs
  add column if not exists service_plan  text not null default 'one_time',
  add column if not exists property_type text not null default 'residential',
  -- 1 = first clean (full price), 2+ = discounted repeat visits.
  add column if not exists visit_number int not null default 1,
  -- Set on the follow-up job so a chain of visits can be traced back.
  add column if not exists previous_job_id uuid references public.jobs (id) on delete set null;

comment on column public.jobs.visit_number is
  'Which cleaning this is for the customer on this plan. 1 is full price; 2+ get the plan discount.';
comment on column public.customers.service_plan is
  'The plan governing future visits. Copied from the lead at scheduling, and editable on the customer.';
comment on column public.customers.property_type is
  'residential or commercial. Picks which discount tier the plan uses.';

-- Recurring customers are looked up by plan when reviewing who is due.
create index if not exists customers_service_plan_idx
  on public.customers (service_plan)
  where service_plan <> 'one_time';

-- Finding the latest visit for a customer drives the next visit_number.
create index if not exists jobs_customer_visit_idx
  on public.jobs (customer_id, visit_number desc);

-- Warn rather than alter: if these columns are constrained, the new values
-- need adding by hand. Silently dropping a constraint isn't a migration's job.
do $$
declare
  c record;
begin
  for c in
    select rel.relname as tbl, con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname in ('leads', 'customers', 'jobs')
      and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) ilike '%service_plan%'
        or pg_get_constraintdef(con.oid) ilike '%property_type%')
  loop
    raise notice
      '%.% is constrained by % (%). Allow one_time/biannual/quarterly and residential/commercial.',
      'public', c.tbl, c.conname, c.def;
  end loop;
end;
$$;
