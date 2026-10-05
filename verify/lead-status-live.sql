-- Why won't a lead save as Lost?
--
-- ###########################################################################
-- #  READ-ONLY. Safe to paste into the Supabase SQL editor.                 #
-- #  Writes nothing, drops nothing, needs no scratch database.              #
-- ###########################################################################
--
-- Five rows. Row 1 is the one that usually explains it.
--
-- THE LIKELY STORY. 'lost' and 'archived' were added to the app in
-- db/lead-events.sql. That file deliberately does NOT touch a CHECK
-- constraint it finds on leads.status — it raises a NOTICE telling you to
-- edit it yourself, because silently dropping a constraint nobody expected
-- is not something a migration should do. In the Supabase SQL editor a
-- NOTICE scrolls past above the result grid and is easy to miss.
--
-- If that is what happened, the status list in the dropdown (which lives in
-- JavaScript, in LEADS_SETTABLE_STATUSES) has offered 'lost' ever since,
-- while the database has been rejecting it. The first person to actually
-- lose a lead finds out.
--
-- Fix: db/lead-status-constraint.sql.

with con as (
  select c.conname, pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_class r on r.oid = c.conrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public' and r.relname = 'leads'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
  limit 1
),
trg as (
  select count(*)::int as n
  from pg_trigger t
  join pg_class r on r.oid = t.tgrelid
  join pg_namespace n on n.oid = r.relnamespace
  where n.nspname = 'public' and r.relname = 'leads' and not t.tgisinternal
),
used as (
  select string_agg(distinct status, ', ' order by status) as list
  from public.leads
)
select * from (
  select
    1 as n,
    'is leads.status constrained?' as check,
    case
      when (select conname from con) is null
        then 'NO — the column is plain text, so a CHECK constraint is not what is stopping the save. Look at rows 2-5.'
      when (select def from con) ilike '%''lost''%'
        then 'YES, and it already allows ''lost'' — so this is not it either.'
      else 'THIS IS IT — ' || (select conname from con) || ' does not list ''lost''. '
           || 'Run db/lead-status-constraint.sql.'
    end as result

  union all select
    2,
    'what the constraint actually says',
    coalesce((select def from con), '(no CHECK constraint on leads.status)')

  union all select
    3,
    'does it allow ''archived'' either?',
    case
      when (select conname from con) is null then 'n/a — no constraint'
      when (select def from con) ilike '%''archived''%' then 'yes'
      else 'NO — archiving a lead is broken in exactly the same way, and nobody has hit it yet'
    end

  union all select
    4,
    'statuses actually in use today',
    coalesce((select list from used), '(no leads)')

  union all select
    5,
    'triggers on leads that could refuse an update',
    (select n from trg) || ' user trigger(s). If row 1 says NO, one of these '
    || 'or a trigger on lead_events is the next place to look — the real '
    || 'message is in the browser console, and after the LeadDetail fix it is on screen.'
) rows
order by n;
