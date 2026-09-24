-- Did db/sms-delivery.sql actually land?
--
-- READ ONLY. Nothing in this file writes, deletes or alters anything, so it
-- is safe to paste into the Supabase SQL editor — which is the whole point
-- of it existing separately from verify/sms-delivery.sql, which is not.
--
-- Why it is needed
-- ----------------
-- db/sms.sql and db/sms-delivery.sql both define claim_sms(), and the second
-- one adds the check that stops the CRM texting a number the carrier has
-- refused. Running them in that order is correct. Running them the other way
-- round, or re-running sms.sql afterwards for any reason, silently puts the
-- older claim_sms() back — while the new status, the new index and the new
-- tables all stay in place.
--
-- Nothing errors. Texts to a dead number simply start going out again, and
-- the only symptom is a bill and a quote nobody receives. So: check.

select
  'claim_sms refuses unreachable numbers' as check,
  coalesce(
    (select prosrc like '%sb_sms_unreachable%'
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'claim_sms'
      limit 1),
    false
  ) as pass,
  'if false, re-run db/sms-delivery.sql — sms.sql has overwritten it' as if_it_fails

union all select
  'the undelivered status is allowed',
  exists (
    select 1 from pg_constraint
     where conname = 'sms_messages_status_check'
       and pg_get_constraintdef(oid) like '%undelivered%'
  ),
  'if false, db/sms-delivery.sql did not finish'

union all select
  'the double-send guard covers undelivered rows',
  coalesce(
    (select indexdef like '%undelivered%'
       from pg_indexes
      where schemaname = 'public' and indexname = 'sms_messages_dedupe_idx'),
    false
  ),
  'if false, a carrier rejection will be re-sent every night'

union all select
  'the unreachable list exists',
  to_regclass('public.sms_unreachable') is not null,
  'if false, db/sms-delivery.sql did not finish'

union all select
  'the failures view exists',
  to_regclass('public.sms_failures') is not null,
  'if false, db/sms-delivery.sql did not finish'

union all select
  'the failures view runs as the caller',
  coalesce(
    (select reloptions::text like '%security_invoker=%'
       from pg_class where relname = 'sms_failures'),
    false
  ),
  'if false the view ignores row-level security — see db/rls-phase-1b.sql'

union all select
  'the webhook can record a verdict',
  exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'mark_sms_undelivered'
  ),
  'if false, every delivery receipt will be logged and dropped';

-- And what it has found so far. Empty is the right answer on day one.
select count(*) filter (where status = 'undelivered') as undelivered,
       count(*) filter (where status = 'failed')      as failed_to_send,
       (select count(*) from public.sms_unreachable
         where cleared_at is null)                    as numbers_closed
  from public.sms_messages;
