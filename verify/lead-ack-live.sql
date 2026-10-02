-- Did the acknowledgment migration land, and is the SMS guard still intact?
--
-- ###########################################################################
-- #  READ-ONLY. Safe to paste into the Supabase SQL editor.                 #
-- #  Writes nothing, drops nothing, needs no scratch database.              #
-- ###########################################################################
--
-- Four rows. Every one should say OK.
--
-- Rows 1 and 2 are the ones that matter most, and they are not about acks at
-- all. claim_sms()'s ON CONFLICT clause and the sms_messages_dedupe_idx
-- predicate have to state the SAME set of statuses. If they disagree,
-- Postgres raises "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" and EVERY text the CRM tries to send fails —
-- quotes, reminders, nudges, all of it.
--
-- They can come to disagree in two ways:
--   * re-running db/sms.sql on its own, which replaces claim_sms() with the
--     original two-status version while the index stays at three; or
--   * running db/lead-ack.sql, which rebuilds the index and has to put the
--     three-status predicate back.
--
-- If row 1 or 2 says PROBLEM, the fix is to run db/sms-delivery.sql again.

with idx as (
  select pg_get_expr(i.indpred, i.indrelid) as predicate
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'sms_messages_dedupe_idx'
),
fn as (
  select pg_get_functiondef(p.oid) as src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_sms'
  limit 1
),
col as (
  select pg_get_expr(d.adbin, d.adrelid) as expr
  from pg_attrdef d
  join pg_class c on c.oid = d.adrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum = d.adnum
  where n.nspname = 'public' and c.relname = 'sms_messages'
    and a.attname = 'dedupe_key'
)
select * from (
  select
    1 as n,
    'dedupe index covers undelivered' as check,
    case
      when (select predicate from idx) is null then 'PROBLEM — the index is missing'
      when (select predicate from idx) like '%undelivered%' then 'OK'
      else 'PROBLEM — run db/sms-delivery.sql again'
    end as result

  union all select
    2,
    'claim_sms agrees with the index',
    case
      when (select src from fn) is null then 'PROBLEM — claim_sms is missing; run db/sms.sql'
      when (select src from fn) like '%undelivered%'
       and (select predicate from idx) like '%undelivered%' then 'OK'
      when (select src from fn) not like '%undelivered%'
        then 'PROBLEM — claim_sms is the old 2-status version. Run db/sms-delivery.sql again'
      else 'PROBLEM — they disagree. Run db/sms-delivery.sql again'
    end

  union all select
    3,
    'dedupe key knows about acks',
    case
      when (select expr from col) is null then 'PROBLEM — dedupe_key is missing'
      when (select expr from col) like '%ack:l:%' then 'OK'
      else 'NOT YET — run db/lead-ack.sql'
    end

  union all select
    4,
    'the due-acknowledgments query exists',
    case
      when to_regprocedure('public.sms_due_lead_acks(int)') is not null then 'OK'
      else 'NOT YET — run db/lead-ack.sql'
    end
) rows
order by n;
