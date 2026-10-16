\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE WRITES AND DROPS TABLES. Throwaway Postgres only, never      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

-- verify/quote-accept-job-fixture.sql
--
-- Extends verify/quotes-fixture.sql with the parts of `jobs` and
-- `customer_properties` that db/quote-accept-job.sql actually touches.
--
-- Run order:
--   verify/quotes-fixture.sql
--   db/quotes.sql
--   db/quote-close.sql
--   this file          <- adds the columns quote-property.sql and the real
--                         jobs table would already have
--   db/quote-accept-job.sql
--   verify/quote-accept-job.sql
--
-- WHY THE COLUMNS ARE ADDED HERE RATHER THAN IN quotes-fixture.sql. That
-- fixture is shared with verify/quotes.sql and verify/quote-history.sql, and
-- its `jobs` is deliberately the four columns db/quote-close.sql reads —
-- "Minimal, and only the columns the migration touches." Widening a shared
-- fixture to suit one new suite is how a fixture stops describing anything.

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it writes rows. It only '
      'runs against a scratch database built by verify/quotes-fixture.sql.';
  end if;
end $$;

-- The real jobs table has no DDL anywhere in db/ — it was made by hand in
-- the Supabase dashboard before db/ existed, like leads.stories and
-- leads.interior. So this is reconstructed from what the app reads and
-- writes (src/services/jobService.js), and it is a RECONSTRUCTION: a NOT
-- NULL constraint that exists only in production cannot be caught here.
-- Noted rather than papered over.
alter table public.jobs
  add column if not exists service_keys   text[] default '{}',
  add column if not exists services       text,
  add column if not exists starts_at      timestamptz,
  add column if not exists completed_at   timestamptz,
  add column if not exists property_id    uuid,
  add column if not exists address        text,
  add column if not exists service_plan   text,
  add column if not exists property_type  text,
  add column if not exists visit_number   int,
  add column if not exists is_extra       boolean default false,
  add column if not exists duration_hours numeric,
  add column if not exists notes          text,
  add column if not exists created_at     timestamptz default now();

-- db/quote-property.sql, reduced to the one column this suite needs. The
-- real file also builds customer_properties and a backfill; neither is
-- reached from sb_accept_quote.
alter table public.quotes
  add column if not exists property_id uuid;
