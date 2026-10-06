-- Extra fixture for verify/lead-nudges.sql, on top of verify/sms-fixture.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. It alters tables in a throwaway        #
-- #  stand-in schema. db/*.sql are the real migrations; verify/*.sql are not.#
-- ############################################################################
--
-- sms-fixture.sql builds the tables the SMS code touches. The nudges read
-- three more columns off `leads` that the SMS path never looked at.
--
-- Run order:
--   verify/sms-fixture.sql
--   db/sms.sql, db/sms-delivery.sql, db/lead-events.sql
--   verify/lead-nudge-fixture.sql   <- this
--
-- db/lead-ack.sql is deliberately NOT in this chain. The nudges do not depend
-- on it -- sb_sms_dedupe_key() carries the 'ack' case itself -- and pulling it
-- in would drag db/email-delivery.sql along with it for no assertion here.
-- The PRODUCTION order still puts lead-ack first; see the note in
-- db/lead-nudges.sql about what happens if it is run afterwards.
--   db/lead-nudges.sql
--   verify/lead-nudges.sql

\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it alters tables. It only '
      'runs against a scratch database built by verify/sms-fixture.sql.';
  end if;
end $$;

alter table public.leads
  -- What they want doing. Named in the contacted and quoted messages so an
  -- unknown number is not asking a stranger about "your details".
  add column if not exists service        text,
  -- The number the quoted message is entirely about.
  add column if not exists estimate       numeric,
  -- The time the booked message confirms. Without it that nudge never sends.
  add column if not exists appointment_at timestamptz;
