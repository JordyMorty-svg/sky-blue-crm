-- Sky Blue CRM — let leads.status hold every status the app can set
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- THE BUG THIS FIXES
-- ------------------
-- Marking a lead Lost failed with nothing useful on screen. The status
-- dropdown is built from LEADS_SETTABLE_STATUSES in
-- src/services/leadService.js, which has offered 'lost' and 'archived' since
-- db/lead-events.sql added them. The database never agreed.
--
-- db/lead-events.sql found the CHECK constraint on leads.status and
-- deliberately refused to touch it:
--
--     raise notice
--       'leads.status is constrained by % (%). Add ''lost'' to it before
--        using the new status.'
--
-- That was the right instinct and the wrong delivery. A NOTICE in the
-- Supabase SQL editor prints above the result grid, where nobody is looking,
-- and the migration reported success. So the app gained two statuses, the
-- database kept rejecting them, and the failure waited for the first lead
-- somebody actually lost. Which is the worst possible moment for it, because
-- by then you are trying to record a real outcome, not test a feature.
--
-- WHAT THIS DOES INSTEAD
-- ----------------------
-- Rebuilds the constraint to cover the full status list, as one statement,
-- and says out loud what it changed.
--
-- It only ever WIDENS. It refuses outright if any existing row holds a
-- status the new list does not cover, rather than dropping the old
-- constraint and failing halfway, which would leave the table with no
-- constraint at all and the fix looking like it worked.
--
-- If there is no constraint to begin with, nothing happens and it says so —
-- in that case the save is failing for some other reason and the error on
-- the lead page will now name it.

do $$
declare
  -- The eight statuses ALL_STATUSES holds in leadService.js. Three of them
  -- (new, scheduled, completed) are set by other parts of the app rather
  -- than by this dropdown, and they belong here all the same: this is the
  -- set of values the column may hold, not the set a person may type.
  allowed  text[] := array[
    'new', 'contacted', 'quoted', 'booked',
    'scheduled', 'completed', 'lost', 'archived'
  ];
  con      record;
  stray    text;
  n_rows   int;
  old_list text[];
  dropped  text[];
begin
  select c.conname, pg_get_constraintdef(c.oid) as def
    into con
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public'
    and r.relname = 'leads'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
  limit 1;

  if con.conname is null then
    raise notice
      'No CHECK constraint on leads.status, so this was never what blocked the save. '
      'Nothing changed. The real error now shows on the lead page itself.';
    return;
  end if;

  -- Matched on the bare words, not on quoted literals. Postgres renders
  -- `status in ('a','b')` and `status = any('{a,b}'::text[])` differently,
  -- and the second one is what THIS file produces — so a check written for
  -- quoted literals finds nothing on the second run and rebuilds a
  -- constraint that was already correct. Harmless, but it reports
  -- "Replacing" while changing nothing, and it takes an ACCESS EXCLUSIVE
  -- lock to do it.
  if con.def like '%lost%' and con.def like '%archived%' then
    raise notice 'Constraint % already allows lost and archived; nothing to do.', con.conname;
    return;
  end if;

  -- Refuse before destroying anything. Two different ways the new list can
  -- be wrong, and BOTH have to be checked before the DROP, because finding
  -- out afterwards leaves the column with no constraint at all.

  -- (1) A status already in the table that the new list does not cover.
  select status, count(*)
    into stray, n_rows
  from public.leads
  where status is not null and not (status = any(allowed))
  group by status
  limit 1;

  if stray is not null then
    raise exception
      'REFUSING. % lead(s) already hold status %, which is not in the new list. '
      'Add it to `allowed` in this file, or fix those rows, then run this again. '
      'The old constraint has not been touched.',
      n_rows, quote_literal(stray);
  end if;

  -- (2) A status the OLD CONSTRAINT permitted that the new list does not.
  --
  -- Checking the rows is not enough, and the first version of this file made
  -- exactly that mistake. No lead holding a status proves nothing about
  -- whether the column was ALLOWED to hold it — a status that is valid but
  -- unused today would be quietly removed, and the next lead that needed it
  -- would fail the same way 'lost' just did. This file claims to only ever
  -- widen; this is what makes that true rather than nearly true.
  --
  -- The list is read back out of the constraint definition, which Postgres
  -- renders two ways depending on how it was written:
  --   status in ('a','b')          -> ... ARRAY['a'::text, 'b'::text]
  --   status = any('{a,b}'::text[]) -> ... ANY ('{a,b}'::text[])
  -- The first regexp catches the quoted literals of form one; if that finds
  -- nothing, the second unpacks the brace list of form two.
  select coalesce(
           nullif(array(select (regexp_matches(con.def, '''([a-z_]+)''::text', 'g'))[1]), '{}'),
           string_to_array(
             btrim(coalesce(substring(con.def from '''\{([^}]*)\}'''), ''), '{}'), ',')
         )
    into old_list;

  select array(select unnest(old_list) except select unnest(allowed))
    into dropped;

  if array_length(dropped, 1) > 0 then
    raise exception
      'REFUSING. The existing constraint allows %, which the new list does not. '
      'Replacing it would narrow the column, not widen it. Add those to '
      '`allowed` in this file (and to ALL_STATUSES in leadService.js) and run '
      'it again. The old constraint has not been touched.',
      array_to_string(dropped, ', ');
  end if;

  raise notice 'Replacing % (%)', con.conname, con.def;

  execute format('alter table public.leads drop constraint %I', con.conname);

  execute format(
    'alter table public.leads add constraint leads_status_check '
    'check (status is null or status = any (%L))',
    allowed
  );

  raise notice 'leads.status now allows: %', array_to_string(allowed, ', ');
end;
$$;

comment on column public.leads.status is
  'Where the lead is in the pipeline. The permitted values are pinned by
   leads_status_check and must stay in step with ALL_STATUSES in
   src/services/leadService.js — adding one to the dropdown without adding it
   here is what broke marking leads Lost.';

-- ---------------------------------------------------------------------------
-- What you have now
-- ---------------------------------------------------------------------------

select
  l.status,
  count(*) as leads
from public.leads l
group by l.status
order by count(*) desc;
