-- Did db/quote-sender-name.sql and db/email-delivery.sql actually land?
--
-- READ ONLY. Nothing here writes, deletes or alters anything, so it is safe
-- to paste into the Supabase SQL editor — which is the whole point of it
-- existing separately from verify/email-delivery.sql, which is not.
--
-- ONE statement, deliberately. The Supabase SQL editor shows only the LAST
-- result set, so a file with the checks in one query and a summary in
-- another shows the summary and hides the checks — which is how a run can
-- look like it said nothing was wrong. Everything is one UNION ALL.

select
  case when pass then 'ok' else '>>> FAIL' end as result,
  what,
  fix
from (
  select
    'quotes sign with the name of whoever sent them' as what,
    coalesce((
      select prosrc like '%full_name%'
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'sms_due_quote_nudges'
       limit 1
    ), false) as pass,
    're-run db/quote-sender-name.sql' as fix,
    1 as ord

  union all select
    'the email fallback knows who sent the quote',
    coalesce((
      select prosrc like '%full_name%'
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'quote_for_email'
       limit 1
    ), false),
    're-run db/quote-sender-name.sql AFTER db/sms-delivery.sql — running them '
    'the other way round puts the old version back', 2

  union all select
    'sent emails are recorded',
    to_regclass('public.sent_emails') is not null,
    're-run db/email-delivery.sql', 3

  union all select
    'the closed-address list exists',
    to_regclass('public.email_unreachable') is not null,
    're-run db/email-delivery.sql', 4

  union all select
    'the combined failures list exists',
    to_regclass('public.delivery_failures') is not null,
    're-run db/email-delivery.sql', 5

  union all select
    'the combined list runs as the caller',
    coalesce((
      select reloptions::text like '%security_invoker=%'
        from pg_class where relname = 'delivery_failures'
    ), false),
    'without this the view ignores row-level security', 6

  union all select
    'the Resend webhook can record a bounce',
    exists (
      select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'mark_email_failed'
    ),
    'without this every bounce is logged and dropped', 7

  union all select
    'a refused reminder can be emailed instead',
    exists (
      select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'reminder_for_email'
    ),
    're-run db/email-delivery.sql', 8

  union all select
    'a quote for $550 does not look like a dead address',
    not public.sb_email_permanent('Rejected: Your quote for $550 - screens included'),
    'the bounce classifier is too loose and will suppress real customers', 9

  union all select
    'a real hard bounce still does',
    public.sb_email_permanent('Permanent: mailbox does not exist'),
    'the bounce classifier is too strict and nothing will ever be suppressed', 10

  -- Not checks, just what it has found so far. Zeroes are the right answer
  -- until the Resend webhook is added and an email actually bounces.
  union all select
    'emails recorded so far: ' ||
      (select count(*) from public.sent_emails),
    true, '', 11

  union all select
    'emails that bounced: ' ||
      (select count(*) from public.sent_emails where status = 'bounced'),
    true, '', 12

  union all select
    'spam complaints: ' ||
      (select count(*) from public.sent_emails where status = 'complained'),
    true, '', 13

  union all select
    'addresses now closed to email: ' ||
      (select count(*) from public.email_unreachable where cleared_at is null),
    true, '', 14
) checks
order by ord;
