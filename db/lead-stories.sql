-- db/lead-stories.sql
--
-- Letting a lead be three storeys.
--
-- Safe to re-run. Run it BEFORE deploying the website change that offers a
-- third storey on the quote form, or the first three-storey enquiry arrives
-- missing its storey count.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE HAD TO BE WRITTEN BLIND
-- ---------------------------------------------------------------------------
--
-- `leads.stories` has a CHECK constraint and it is in none of these files.
-- It was created in the Supabase dashboard before db/ existed, which means
-- the only record of what it allows is the live database — and the only
-- note of its existence anywhere is a comment in the website's quote form:
--
--     stories,              // 'one' | 'two' — matches the CHECK constraint
--
-- That comment is two years old and may or may not still be true. So
-- section 1 PRINTS the constraint rather than assuming it, and section 2
-- replaces it with one that is written down in a file from now on.
--
-- The same is true of `service` and of the other columns the original
-- schema created by hand. This file fixes one of them; the rest are still
-- only knowable by looking.
--
-- ---------------------------------------------------------------------------
-- WHAT HAPPENS IF THIS IS NOT RUN
-- ---------------------------------------------------------------------------
--
-- The website survives it, deliberately — insertLead() in
-- src/lib/leadSubmit.js now treats a check violation the same way it treats
-- an unknown column: drop the offending field and insert again, so the
-- enquiry still lands. It lands looking like a one-storey house, which is
-- why the quote form also writes "Three story house" into the notes.
--
-- That is a safety net, not the fix. A lead whose storey count is in a
-- paragraph instead of a column cannot be filtered, counted, or priced
-- from. Run this.


-- ---------------------------------------------------------------------------
-- 1. What is there now
-- ---------------------------------------------------------------------------

do $$
declare
  rec record;
  found boolean := false;
begin
  for rec in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'leads'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%stories%'
  loop
    found := true;
    raise notice 'existing constraint % : %', rec.conname, rec.def;
  end loop;

  if not found then
    raise notice 'no CHECK constraint on leads.stories — section 2 adds one';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Replace it with one that allows three
-- ---------------------------------------------------------------------------
--
-- DROPPED BY DISCOVERY, NOT BY NAME. The constraint was made by hand, so
-- its name is whatever the dashboard generated — leads_stories_check if it
-- came from a column definition, something else if somebody typed it. The
-- loop finds every check on this table that mentions the column and removes
-- it, which is the only way to be sure the new one is the only one left.
-- Two overlapping checks would both have to pass, and the older, narrower
-- one would silently keep winning.

do $$
declare rec record;
begin
  for rec in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'leads'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%stories%'
  loop
    execute format('alter table public.leads drop constraint %I', rec.conname);
    raise notice 'dropped %', rec.conname;
  end loop;
end;
$$;

-- NULL IS ALLOWED, and that is not an oversight. The second quote form
-- (QuoteRequestForm, the one on the service pages) asks for a service and a
-- contact and deliberately sends stories as null — it is not a window
-- calculator. A constraint that refused null would reject every lead from
-- those six pages.
alter table public.leads
  add constraint leads_stories_check
  check (stories is null or stories in ('one', 'two', 'three'));

comment on column public.leads.stories is
  'one | two | three, or null when the form did not ask. Constrained by
   leads_stories_check — see db/lead-stories.sql. The website''s quote form
   is the only thing that sets it; STOREYS in QuoteForm.jsx must stay in
   step with the values above.';


-- ---------------------------------------------------------------------------
-- 3. Nothing already in the table is now illegal
-- ---------------------------------------------------------------------------
--
-- Adding a constraint validates existing rows, so a bad value would have
-- failed section 2 outright rather than reaching here. This reports what is
-- actually in the column, which is the useful thing to see afterwards: if
-- it lists a value this file does not allow, section 2 could not have run.

do $$
declare rec record;
begin
  for rec in
    select coalesce(stories, '(null)') as v, count(*) as n
    from public.leads group by 1 order by 2 desc
  loop
    raise notice 'stories = % : % lead(s)', rec.v, rec.n;
  end loop;
end;
$$;
