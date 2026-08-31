-- Sky Blue CRM — recording that we reached out
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Tapping a lead's phone number now both dials it and records the attempt.
-- This is the schema behind that.

-- ---------------------------------------------------------------------------
-- 1. When we last reached out
-- ---------------------------------------------------------------------------

alter table public.leads
  add column if not exists last_contacted_at timestamptz,
  add column if not exists contact_attempts  int not null default 0;

comment on column public.leads.last_contacted_at is
  'When someone last tried to reach this lead. Stamped by
   record_lead_contact() when the phone number is tapped.';
comment on column public.leads.contact_attempts is
  'How many times we have tried. Three calls and no answer is a different
   situation from one, and it is the number a follow-up rule would read.';

-- ---------------------------------------------------------------------------
-- 2. lead_events learns to record more than status
-- ---------------------------------------------------------------------------

-- Same shape as job_events: `kind` says what sort of thing happened, so a
-- new kind never needs a migration. Existing rows are all status changes,
-- which is what the default backfills them as.
alter table public.lead_events
  add column if not exists kind text not null default 'status';

-- A call doesn't necessarily move the lead anywhere, so to_status can no
-- longer be required. Every existing row already has one.
alter table public.lead_events
  alter column to_status drop not null;

comment on column public.lead_events.kind is
  'status | call. Text rather than an enum so adding "text" or "email"
   later is app-side only.';

-- ---------------------------------------------------------------------------
-- 3. One click, one event
-- ---------------------------------------------------------------------------

-- Calling a lead that is still 'new' does two things at once: it records
-- the attempt AND moves them to 'contacted'. Those are one action and
-- belong on one row — logging them separately would put "Called" and
-- "new -> contacted" on the history a second apart, which is the same
-- double-entry that had to be fixed on job plan changes.
--
-- So this function replaces the status-only logger and handles both. The
-- trigger below widens from `update of status` to plain `update`, since a
-- contact stamp touches a different column.
create or replace function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor     uuid;
  contacted boolean;
  moved     boolean;
begin
  -- Resolve the acting user, but only if they have a profiles row. A raw
  -- auth.uid() with no matching profile would violate the foreign key and
  -- block the change itself — logging history must never be able to stop
  -- the CRM working. Null just means "actor unknown".
  select p.id into actor from public.profiles p where p.id = auth.uid();

  if tg_op = 'INSERT' then
    insert into public.lead_events (lead_id, kind, from_status, to_status, changed_by)
    values (new.id, 'status', null, new.status, actor);
    return new;
  end if;

  contacted := new.last_contacted_at is distinct from old.last_contacted_at
               and new.last_contacted_at is not null;
  moved     := new.status is distinct from old.status;

  if contacted then
    -- Carries the move when there was one, so the history reads
    -- "Called · New -> Contacted" on a single line.
    insert into public.lead_events (lead_id, kind, from_status, to_status, changed_by)
    values (
      new.id, 'call',
      case when moved then old.status else null end,
      case when moved then new.status else null end,
      actor
    );

  -- Only log real transitions. Saving the lead detail form rewrites every
  -- column, so without this guard every edit would create a noise event.
  elsif moved then
    insert into public.lead_events (lead_id, kind, from_status, to_status, changed_by)
    values (new.id, 'status', old.status, new.status, actor);
  end if;

  return new;
end;
$$;

drop trigger if exists leads_status_change on public.leads;

create trigger leads_status_change
  after insert or update on public.leads
  for each row
  execute function public.log_lead_status_change();

-- ---------------------------------------------------------------------------
-- 4. Recording a call
-- ---------------------------------------------------------------------------

-- Why a function rather than a plain update from the app:
--
--   * contact_attempts has to be incremented server-side. PostgREST can't
--     express `col = col + 1`, so the app would have to read then write,
--     and two people ringing the same lead would lose a count.
--
--   * THE STATUS RULE. A lead's status is its position in the funnel, not
--     a contact log. Calling someone who is already 'quoted' must not drag
--     them back to 'contacted' — that erases where they actually got to,
--     and the pipeline would start walking backwards every time anyone
--     picked up the phone. So the status only advances from 'new', which
--     is the one case where "we reached out" genuinely IS the new status.
--     Everything else just gets the timestamp.
--
-- Putting that rule here rather than in the app means it holds however the
-- call is recorded — board, lead page, or anything added later.
create or replace function public.record_lead_contact(p_lead_id uuid)
returns public.leads
language plpgsql
security invoker
set search_path = public
as $$
declare
  updated public.leads;
begin
  update public.leads
  set last_contacted_at = now(),
      contact_attempts  = coalesce(contact_attempts, 0) + 1,
      status = case when status = 'new' then 'contacted' else status end
  where id = p_lead_id
  returning * into updated;

  if updated.id is null then
    raise exception 'No lead with id %', p_lead_id;
  end if;

  return updated;
end;
$$;

comment on function public.record_lead_contact(uuid) is
  'Stamp an outreach attempt. Advances status only from new -> contacted;
   a lead further down the funnel keeps its place.';

grant execute on function public.record_lead_contact(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. A note on staleness
-- ---------------------------------------------------------------------------

-- Nothing to change, but worth knowing: lead_status_age derives its age
-- from max(lead_events.created_at), so a call now counts as activity and a
-- lead you rang yesterday stops showing as stale. That's the behaviour you
-- want and it comes for free — the view is untouched.

-- ---------------------------------------------------------------------------
-- 6. What you've got
-- ---------------------------------------------------------------------------

select
  l.name,
  l.status,
  l.contact_attempts                                   as tries,
  l.last_contacted_at,
  count(e.id) filter (where e.kind = 'call')           as calls_logged
from public.leads l
left join public.lead_events e on e.lead_id = l.id
group by l.id, l.name, l.status, l.contact_attempts, l.last_contacted_at
order by l.last_contacted_at desc nulls last
limit 20;
