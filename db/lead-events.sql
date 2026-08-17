-- Sky Blue CRM — lead status history + the 'lost' status
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- Why a trigger instead of writing events from the app: status is changed in
-- five different places today (the pipeline board, the lead detail page, the
-- All Leads bulk action, scheduleJob and completeJob), and more will appear.
-- A trigger cannot be forgotten, and it also catches edits made by hand in
-- the Supabase table editor.

-- ---------------------------------------------------------------------------
-- 1. The events table
-- ---------------------------------------------------------------------------

create table if not exists public.lead_events (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references public.leads (id) on delete cascade,
  from_status text,                    -- null on the creation event
  to_status   text not null,
  -- References profiles, not auth.users, so PostgREST can embed the actor's
  -- name directly: .select("*, actor:changed_by ( full_name )"). Same shape
  -- as leads.created_by.
  changed_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- If an earlier version of this migration created changed_by pointing at
-- auth.users, repoint it. Without this the actor's name can't be joined.
do $$
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class fref on fref.oid = con.confrelid
    join pg_namespace fns on fns.oid = fref.relnamespace
    where rel.relname = 'lead_events'
      and con.contype = 'f'
      and fns.nspname = 'auth'
      and fref.relname = 'users'
  ) then
    alter table public.lead_events
      drop constraint if exists lead_events_changed_by_fkey;
    alter table public.lead_events
      add constraint lead_events_changed_by_fkey
      foreign key (changed_by) references public.profiles (id) on delete set null;
    raise notice 'Repointed lead_events.changed_by at public.profiles.';
  end if;
end;
$$;

-- The common query is "history for this lead, newest first" and
-- "latest event per lead" for staleness.
create index if not exists lead_events_lead_id_created_at_idx
  on public.lead_events (lead_id, created_at desc);

comment on table public.lead_events is
  'Append-only history of lead status changes. Written by a trigger on leads.';
comment on column public.lead_events.from_status is
  'Null means this row records the lead being created.';

-- ---------------------------------------------------------------------------
-- 2. The trigger
-- ---------------------------------------------------------------------------

create or replace function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
begin
  -- Resolve the acting user, but only if they have a profiles row. A raw
  -- auth.uid() with no matching profile would violate the foreign key and
  -- block the status change itself — logging history must never be able to
  -- stop the CRM working. Null here just means "actor unknown", which is
  -- also what you get for edits made in the Supabase table editor.
  select p.id into actor from public.profiles p where p.id = auth.uid();

  if tg_op = 'INSERT' then
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, actor);
    return new;
  end if;

  -- Only log real transitions. Saving the lead detail form rewrites every
  -- column, so without this guard every edit would create a noise event.
  if new.status is distinct from old.status then
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, actor);
  end if;

  return new;
end;
$$;

drop trigger if exists leads_status_change on public.leads;

create trigger leads_status_change
  after insert or update of status on public.leads
  for each row
  execute function public.log_lead_status_change();

-- ---------------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------------

alter table public.lead_events enable row level security;

-- Any signed-in team member can read the history.
drop policy if exists "lead_events readable by authenticated" on public.lead_events;
create policy "lead_events readable by authenticated"
  on public.lead_events for select
  to authenticated
  using (true);

-- Nobody writes directly — the trigger is security definer, so it inserts
-- regardless. Leaving out an insert policy keeps the log append-only from
-- the app's point of view.

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------

-- Seed one creation event per existing lead so nothing shows as having no
-- history at all. created_at is the lead's own creation time, which is the
-- only honest timestamp available — we can't invent the stages in between.
-- created_by is the only actor we can honestly attribute a backfilled event
-- to, and only when that user still has a profile.
insert into public.lead_events (lead_id, from_status, to_status, changed_by, created_at)
select l.id, null, l.status,
       (select p.id from public.profiles p where p.id = l.created_by),
       l.created_at
from public.leads l
where not exists (
  select 1 from public.lead_events e where e.lead_id = l.id
);

-- ---------------------------------------------------------------------------
-- 5. The 'lost' status
-- ---------------------------------------------------------------------------

-- 'lost' is a new terminal status meaning "they said no", as distinct from
-- 'archived' meaning "it went quiet". If leads.status is a plain text column
-- (the usual case) nothing needs to change and this block stays silent.
-- If it's constrained, the notice below tells you exactly what to edit —
-- it does not attempt the change itself, since dropping a constraint you
-- didn't expect is not something a migration should do quietly.
do $$
declare
  c record;
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'leads'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    raise notice
      'leads.status is constrained by % (%). Add ''lost'' to it before using the new status.',
      c.conname, c.def;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Staleness view
-- ---------------------------------------------------------------------------

-- Last status change per lead, and how long ago it was. Staleness is derived
-- here rather than written into leads.status on a timer, so a quiet lead
-- stays exactly where you left it and nothing is lost if the threshold
-- turns out to be wrong.
create or replace view public.lead_status_age as
select
  l.id                                        as lead_id,
  l.status,
  coalesce(max(e.created_at), l.created_at)   as last_change_at,
  extract(
    day from (now() - coalesce(max(e.created_at), l.created_at))
  )::int                                      as days_since_change
from public.leads l
left join public.lead_events e on e.lead_id = l.id
group by l.id, l.status, l.created_at;

comment on view public.lead_status_age is
  'Days since each lead last changed status. Drives the stale badge; the app
   decides the threshold so it can be tuned without a migration.';
