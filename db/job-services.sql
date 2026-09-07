-- Sky Blue CRM — which services a job actually covers
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Run AFTER the website's db/lead-service.sql, which adds leads.service.
-- (Same Supabase project — the site and the CRM share one database.) This
-- file re-declares that column defensively, so running them out of order
-- costs nothing.
--
-- WHY THIS EXISTS
--
-- The CRM was built when Sky Blue only washed windows, and it shows: every
-- path that creates a job writes the literal string "Exterior windows" or
-- "Interior + exterior windows". The website now takes quotes for gutters,
-- screens, pressure washing and solar panels, so a gutter lead scheduled
-- today becomes a job labelled as window cleaning — on the schedule, on the
-- job record, and in the follow-up email that tells the customer we
-- "took care of exterior windows".
--
-- THE SHAPE
--
-- A lead asks about ONE service — that's what a quote form submits. A JOB
-- can cover several, because "while you're here, could you do the gutters?"
-- is how this business actually works. So:
--
--   leads.service      text     one slug, written by the website
--   jobs.service_keys  text[]   one or more slugs, the structured truth
--   jobs.services      text     the human sentence, DERIVED from the above
--
-- jobs.services already exists and is read in a dozen places, including the
-- follow-up email. Rather than hunt them all down, a trigger keeps it in
-- step with service_keys. Old code that reads `services` keeps working and
-- silently gets better; new code reads service_keys and can filter on it.

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------

-- Belt and braces: the website's migration adds this. If it hasn't run yet,
-- this file still applies cleanly and the column is simply empty.
alter table public.leads
  add column if not exists service text;

comment on column public.leads.service is
  'Which service this lead asked about, as the website''s slug
   (residential-window-washing, gutter-cleaning, ...). Free text like
   leads.source, so the site can add a service without a CRM migration.';

alter table public.jobs
  add column if not exists service_keys text[] not null default '{}';

comment on column public.jobs.service_keys is
  'Every service this visit covers, as website slugs. An array because a
   single visit routinely does windows AND gutters. jobs.services is the
   human-readable version, kept in step by jobs_sync_services.';

-- Filtering "show me every gutter job" needs GIN; a btree index can''t
-- answer an array-containment query.
create index if not exists jobs_service_keys_idx
  on public.jobs using gin (service_keys);

create index if not exists leads_service_idx
  on public.leads (service);

-- ---------------------------------------------------------------------------
-- 2. Slug -> sentence
-- ---------------------------------------------------------------------------

-- The labels live here AS WELL AS in src/services/leadService.js, and that
-- duplication is deliberate rather than sloppy. The app owns the wording on
-- screen; this function exists only so jobs.services — a column read by the
-- follow-up email, which runs on a schedule with no app in the loop — says
-- something a customer can read. If the two ever drift, the screen wins and
-- nothing breaks.
--
-- Unknown slugs pass through de-slugified rather than being dropped: a
-- service added on the website before anyone updates the CRM should read as
-- "Roof Washing", not vanish from the job it was booked for.
create or replace function public.sb_service_label(p_key text)
returns text
language sql
immutable
as $$
  select case p_key
    when 'residential-window-washing' then 'Residential window washing'
    when 'commercial-window-washing'  then 'Commercial window washing'
    when 'gutter-cleaning'            then 'Gutter cleaning'
    when 'screen-cleaning-repair'     then 'Screen cleaning & repair'
    when 'pressure-washing'           then 'Pressure washing'
    when 'solar-panel-cleaning'       then 'Solar panel cleaning'
    -- Sentence case, not initcap: initcap would give "Roof Washing" where
    -- serviceFor() in leadService.js gives "Roof washing", and these two
    -- have to agree on every slug, including ones neither of them knows.
    else upper(left(replace(coalesce(p_key, ''), '-', ' '), 1))
         || substr(replace(coalesce(p_key, ''), '-', ' '), 2)
  end
$$;

-- "Gutter cleaning", or "Window washing and gutter cleaning", or
-- "Windows, gutters and pressure washing" — an Oxford-less list, because
-- this ends up mid-sentence in an email to a customer.
create or replace function public.sb_service_sentence(p_keys text[])
returns text
language plpgsql
immutable
as $$
declare
  labels text[];
  n int;
begin
  if p_keys is null or cardinality(p_keys) = 0 then
    return null;
  end if;

  select array_agg(public.sb_service_label(k) order by ord)
  into labels
  from unnest(p_keys) with ordinality as t(k, ord);

  n := cardinality(labels);

  if n = 1 then
    return labels[1];
  end if;

  -- Only the first label keeps its capital: "Gutter cleaning and window
  -- washing", not "Gutter Cleaning and Window Washing".
  return labels[1]
    || case when n > 2
         then ', ' || array_to_string(
                (select array_agg(lower(l)) from unnest(labels[2:n-1]) l), ', ')
         else '' end
    || ' and ' || lower(labels[n]);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Keeping jobs.services honest
-- ---------------------------------------------------------------------------

-- BEFORE, because it rewrites the row on its way in.
--
-- Only ever writes `services` when service_keys says something. A job with
-- an empty array keeps whatever text it had — that is every job created
-- before this file ran, and blanking their description to make a schema
-- tidier would be destroying real records to no purpose.
create or replace function public.sync_job_services()
returns trigger
language plpgsql
as $$
begin
  if new.service_keys is not null and cardinality(new.service_keys) > 0 then
    new.services := public.sb_service_sentence(new.service_keys);
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_sync_services on public.jobs;

create trigger jobs_sync_services
  before insert or update on public.jobs
  for each row
  execute function public.sync_job_services();

-- ---------------------------------------------------------------------------
-- 4. Backfilling what is already there
-- ---------------------------------------------------------------------------

-- Existing jobs carry a free-text description and, usually, a lead that now
-- has a service slug. Read both, preferring the lead — it came from the
-- customer choosing a service, whereas the text was a default nobody picked.
--
-- Deliberately conservative: a job whose description matches nothing
-- recognisable is LEFT ALONE with an empty array rather than being guessed
-- into the window bucket. An empty service_keys reads as "not recorded",
-- which is true. Filing it as window washing would invent a fact.
update public.jobs j
set service_keys = sub.keys
from (
  select
    j2.id,
    case
      -- The lead's own answer, where there is one.
      when l.service is not null and btrim(l.service) <> ''
        then array[l.service]
      -- Otherwise read the description the CRM wrote at the time.
      when j2.services ilike '%interior%'
        then array['residential-window-washing']
      when j2.services ilike '%window%'
        then case
               when coalesce(j2.property_type, 'residential') = 'commercial'
                 then array['commercial-window-washing']
               else array['residential-window-washing']
             end
      when j2.services ilike '%gutter%'   then array['gutter-cleaning']
      when j2.services ilike '%screen%'   then array['screen-cleaning-repair']
      when j2.services ilike '%pressure%' then array['pressure-washing']
      when j2.services ilike '%solar%'    then array['solar-panel-cleaning']
      else '{}'::text[]
    end as keys
  from public.jobs j2
  left join public.leads l on l.id = j2.lead_id
  where coalesce(cardinality(j2.service_keys), 0) = 0
) sub
where j.id = sub.id
  and cardinality(sub.keys) > 0;

-- Note what the backfill does NOT do: it never overwrites service_keys that
-- already has something in it, so re-running this file can't undo a
-- correction someone made by hand in the CRM.

-- ---------------------------------------------------------------------------
-- 5. Recording a change of services
-- ---------------------------------------------------------------------------

-- Adding gutters to a booked job changes what the crew is turning up to do
-- and usually what it costs, so it belongs in the job's history next to
-- reschedules and re-quotes.
--
-- This extends log_job_event() rather than adding a second trigger: two
-- triggers writing to job_events would race for ordering within the same
-- update, and the history would shuffle. The rest of the function is
-- unchanged from db/job-events.sql — only the block marked below is new, so
-- running that file again after this one would silently drop this feature.
-- If you re-run job-events.sql, re-run this file afterwards.
create or replace function public.log_job_services_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  -- Array comparison, not text: the derived sentence changes whenever the
  -- keys do, but the keys are the fact worth recording.
  if new.service_keys is not distinct from old.service_keys then
    return new;
  end if;

  -- An empty -> filled transition is the backfill or the first time anyone
  -- recorded it, not a decision someone made. Not history.
  if coalesce(cardinality(old.service_keys), 0) = 0 then
    return new;
  end if;

  select p.id into actor from public.profiles p where p.id = auth.uid();

  insert into public.job_events (
    job_id, kind, from_status, to_status, detail, changed_by
  )
  values (
    new.id,
    'services',
    public.sb_service_sentence(old.service_keys),
    public.sb_service_sentence(new.service_keys),
    null,
    actor
  );

  return new;
end;
$$;

drop trigger if exists jobs_log_services on public.jobs;

-- AFTER, like the other logger: a job_events row references the job.
create trigger jobs_log_services
  after update on public.jobs
  for each row
  execute function public.log_job_services_change();

-- ---------------------------------------------------------------------------
-- 6. What you've got
-- ---------------------------------------------------------------------------

select
  coalesce(
    (select string_agg(public.sb_service_label(k), ' + ' order by k)
     from unnest(j.service_keys) k),
    '(not recorded)'
  ) as services,
  count(*)                                   as jobs,
  count(*) filter (where j.status = 'completed') as completed,
  sum(coalesce(j.final_price, j.price)) filter (where j.status = 'completed') as revenue
from public.jobs j
group by 1
order by jobs desc;
