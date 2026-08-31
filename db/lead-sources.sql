-- Sky Blue CRM — where a lead came from
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Mostly a safety check rather than a change. `leads.source` already exists
-- and already holds text, so the new picker works without touching the
-- database at all. What this file does is make sure nothing is quietly
-- rejecting the new values, and tidy up rows that never had one.

-- ---------------------------------------------------------------------------
-- 1. Make sure nothing rejects the new sources
-- ---------------------------------------------------------------------------

-- The app writes: door, outreach, website, referral, social, google,
-- signage, other.
--
-- If a CHECK constraint on leads.source was written back when the only
-- values were 'door' and 'website', every new source would be REJECTED —
-- and the app would surface that as a generic "couldn't save the lead"
-- while the real reason sat in the Postgres log. That exact failure mode
-- with jobs.status is why recurring visits silently stopped generating.
--
-- The constraint is DROPPED rather than widened, on purpose. A lead source
-- is a label, not a state machine: it has no invariants to protect, nothing
-- branches on it, and a wrong value is a typo rather than a corruption. The
-- list lives in LEAD_SOURCES in src/services/leadService.js so that adding
-- "Radio ad" next spring is one line of JavaScript instead of a migration.
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
      and rel.relname = 'leads'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%source%'
  loop
    found := true;
    raise notice 'Dropping % on leads.source: %', c.conname, c.def;
    execute format('alter table public.leads drop constraint %I', c.conname);
  end loop;

  if not found then
    raise notice 'No CHECK constraint on leads.source — nothing to drop, the new sources will save fine.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Rows with no source at all
-- ---------------------------------------------------------------------------

-- Every lead in the CRM today was created by createLead, which hard-coded
-- 'door'. A null or empty source means a row that predates that or was
-- inserted by hand, and door-knocking is the honest guess for those — it is
-- how essentially every lead has arrived so far.
--
-- Anything that already HAS a value is left exactly as it is, including
-- values the app doesn't know about. sourceFor() displays an unrecognised
-- value as itself rather than relabelling it.
update public.leads
set source = 'door'
where source is null or btrim(source) = '';

comment on column public.leads.source is
  'How this lead heard about Sky Blue — the marketing channel, not how they
   got in touch. Values come from LEAD_SOURCES in leadService.js: door,
   outreach, website, referral, social, google, signage, other. Deliberately
   unconstrained so a new channel needs no migration.';

-- ---------------------------------------------------------------------------
-- 3. What you've got
-- ---------------------------------------------------------------------------

-- Anything here that isn't one of the eight known keys will show as its raw
-- value in the CRM, and can be re-pointed from the lead's own page.
select
  coalesce(source, '(none)') as source,
  count(*)                   as leads,
  count(*) filter (where status = 'completed') as won
from public.leads
group by source
order by leads desc;
