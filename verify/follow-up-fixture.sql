-- Extra fixture for verify/follow-ups.sql, on top of verify/sms-fixture.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. It alters tables in a throwaway        #
-- #  stand-in schema. db/*.sql are the real migrations; verify/*.sql are not.#
-- ############################################################################
--
-- sms-fixture.sql builds the tables the SMS code touches. db/follow-ups.sql
-- needs two more columns on `jobs` that the SMS path never reads, and that
-- the real schema has had since the beginning. Everything else it needs —
-- email_opt_out, reviewed_at, last_review_request_at, the follow_ups table
-- itself — it adds for itself, so this stays as small as it is.
--
-- Run order:
--   verify/sms-fixture.sql
--   db/sms.sql
--   db/sms-delivery.sql
--   verify/follow-up-fixture.sql   <- this
--   db/follow-ups.sql
--   verify/follow-ups.sql

\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it alters tables. It only '
      'runs against a scratch database built by verify/sms-fixture.sql.';
  end if;
end $$;

alter table public.jobs
  -- Stamped by jobs_stamp_completed in db/job-events.sql on the real
  -- schema. A plain column here: nothing under test writes it, the tests
  -- set it directly to put a job three days or three weeks in the past.
  add column if not exists completed_at timestamptz,
  -- What the job actually came to, as opposed to what it was quoted at.
  add column if not exists final_price numeric;
