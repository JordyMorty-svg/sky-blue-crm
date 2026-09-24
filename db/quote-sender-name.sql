-- db/quote-sender-name.sql
--
-- Put the right name on a quote.
--
-- Every automatic message said "Jordan", because the word was typed into the
-- message templates back when Jordan was the only person who could send one.
-- Hayden sending a quote that introduces him as Jordan is worse than one with
-- no name in it: the customer replies expecting Jordan, or assumes they have
-- been handed to somebody else halfway through.
--
-- quotes.sent_by has recorded who pressed Send since the beginning — that is
-- how the booking fee finds the right person when a customer accepts on their
-- own. It was simply never read back out for the message itself.
--
-- Two functions have to hand it over:
--
--   sms_due_quote_nudges  — the nightly chase-ups, which are sent by nobody
--                           in particular and have to remember whose quote
--                           they are chasing.
--   quote_for_email       — the delivery webhook's "the text was refused,
--                           email it instead" path.
--
-- Safe to re-run. Nothing here is destructive: both functions are dropped and
-- recreated because a RETURNS TABLE signature cannot be widened in place —
-- CREATE OR REPLACE refuses to change a return type, which is an error worth
-- getting once rather than every time.
--
-- Depends on: db/sms.sql, db/sms-delivery.sql (both already applied).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The nightly nudges
-- ---------------------------------------------------------------------------
--
-- Unchanged except for the last column. The joins to leads and customers were
-- already there; profiles is one more left join on a column that is already
-- indexed as a foreign key.
--
-- LEFT joined, deliberately. A quote whose sender has since been removed from
-- profiles must still be chased — it is a live quote to a real customer, and
-- the alternative is that it silently stops being followed up because of a
-- staffing change. sender_name comes back null and the message falls back to
-- signing as the company.

drop function if exists public.sms_due_quote_nudges(int);

create function public.sms_due_quote_nudges(p_limit int default 25)
returns table (
  quote_id      uuid,
  lead_id       uuid,
  customer_id   uuid,
  token         text,
  amount        numeric,
  customer_name text,
  phone         text,
  kind          text,
  sender_name   text
)
language sql
stable
security definer
set search_path = public
as $$
  select q.id,
         q.lead_id,
         q.customer_id,
         q.token,
         q.amount,
         q.customer_name,
         coalesce(l.phone, c.phone) as phone,
         case when q.status = 'viewed' then 'nudge_viewed' else 'nudge_sent' end,
         nullif(btrim(p.full_name), '')
  from public.quotes q
  left join public.leads     l on l.id = q.lead_id
  left join public.customers c on c.id = q.customer_id
  left join public.profiles  p on p.id = q.sent_by
  where q.status in ('sent', 'viewed')
    and q.expires_at > now()
    and coalesce(q.sent_at, q.created_at)
          > now() - (public.sb_sms_window_days() || ' days')::interval
    and case
          when q.status = 'viewed'
            then q.viewed_at < now()
                 - (public.sb_sms_nudge_opened_days() || ' days')::interval
          else coalesce(q.sent_at, q.created_at) < now()
               - (public.sb_sms_nudge_unopened_days() || ' days')::interval
        end
    and public.sb_sms_e164(coalesce(l.phone, c.phone)) is not null
    and not public.sb_sms_opted_out(coalesce(l.phone, c.phone))
    -- The unique index is what actually prevents a second send; this is
    -- here so the run doesn't do the work of building messages it will
    -- then be refused.
    --
    -- 'undelivered' joins the list here. db/sms-delivery.sql widened the
    -- index itself to cover carrier rejections — without the same word in
    -- this check, every night rebuilds a nudge the index then refuses, and
    -- the run reports a skip for a quote nobody needs to look at.
    and not exists (
      select 1 from public.sms_messages m
       where m.quote_id = q.id
         and m.status in ('queued', 'sent', 'undelivered')
         and m.kind = case when q.status = 'viewed'
                           then 'nudge_viewed' else 'nudge_sent' end
    )
  order by coalesce(q.viewed_at, q.sent_at, q.created_at)
  limit p_limit
$$;

grant execute on function public.sms_due_quote_nudges(int) to authenticated;

comment on function public.sms_due_quote_nudges(int) is
  'Quotes due a chase-up, with the name of whoever sent the original so the
   nudge signs itself correctly.';

-- ---------------------------------------------------------------------------
-- 2. The email fallback
-- ---------------------------------------------------------------------------
--
-- Same addition, same reason: an emailed quote signed by the wrong brother is
-- the exact problem this file exists to fix, and the fallback path sends a
-- real quote to a real customer.

drop function if exists public.quote_for_email(uuid);

create function public.quote_for_email(p_quote_id uuid)
returns table (
  out_token        text,
  out_name         text,
  out_email        text,
  out_amount       numeric,
  out_expires      timestamptz,
  out_sender_name  text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    q.token,
    coalesce(nullif(btrim(q.customer_name), ''), c.name, l.name, 'there'),
    coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')),
    q.amount,
    q.expires_at,
    nullif(btrim(p.full_name), '')
  from public.quotes q
  left join public.leads     l on l.id = q.lead_id
  left join public.customers c on c.id = q.customer_id
  left join public.profiles  p on p.id = q.sent_by
  where q.id = p_quote_id
    and coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')) is not null
$$;

grant execute on function public.quote_for_email(uuid) to authenticated;

comment on function public.quote_for_email(uuid) is
  'Everything needed to email a quote whose text was refused, including who
   sent it. Returns no row when there is no address to send to.';
