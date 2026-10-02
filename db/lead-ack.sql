-- Sky Blue CRM -- answering a website enquiry before anyone has read it
--
-- Run once in the Supabase SQL editor, AFTER db/sms.sql and
-- db/email-delivery.sql. Safe to re-run. Plain SQL: no psql meta-commands.
--
-- What this is for
-- ----------------
-- Somebody fills in the form on skybluecleaningco.com at nine on a Sunday
-- night. Nothing happens until Jordan or Hayden next opens the CRM, and in
-- the meantime the person has no idea the message arrived at all -- so they
-- fill in the next company's form too.
--
-- One text, about a minute later: we have it, a real person will be in
-- touch. It costs nothing and it is the difference between being first and
-- being third.
--
-- THE TIMER IS NOT A TECHNICAL DETAIL. An instant reply reads as a robot,
-- and a robot answering "we'll contact you shortly" is worth less than
-- silence because it tells the reader a machine has filed them. A minute
-- reads as somebody glancing at their phone. sb_lead_ack_delay() is a knob
-- precisely so that judgement can be revised without a migration.
--
-- Asserted by verify/lead-ack.sql, which is mutation-tested.

-- ---------------------------------------------------------------------------
-- 1. The knobs
-- ---------------------------------------------------------------------------

create or replace function public.sb_lead_ack_delay()
returns interval language sql immutable as $$ select interval '1 minute' $$;

comment on function public.sb_lead_ack_delay() is
  'How long after a web enquiry arrives before the acknowledgment goes out.
   A minute: long enough not to read as a machine, short enough to land
   while they are still on the site.';

-- Old enquiries are not acknowledged. If the sweep has been down for a day,
-- "thanks for reaching out, we will contact you shortly" arriving 26 hours
-- later is worse than nothing -- it tells somebody who has already given up
-- that the business is slow AND automated.
create or replace function public.sb_lead_ack_stale()
returns interval language sql immutable as $$ select interval '6 hours' $$;

-- ---------------------------------------------------------------------------
-- 2. 'ack' joins the dedupe key
-- ---------------------------------------------------------------------------
--
-- dedupe_key is a GENERATED column, so adding a case to it means dropping
-- and re-adding the column, and the unique index with it. That is the whole
-- reason this section looks heavier than it is. The column is derived, so
-- nothing is lost.
--
-- Why bother, when sms_due_lead_acks() below already refuses a lead that has
-- an ack of any status? Because that is a query and this is a constraint.
-- The sweep runs every minute; two runs overlapping both see the same lead
-- as un-acked and both call claim_sms. The index is what lets exactly one
-- through.
do $$
begin
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sms_messages'
      and a.attname = 'dedupe_key' and not a.attisdropped
  ) and not exists (
    select 1 from pg_attrdef d
    join pg_class c on c.oid = d.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sms_messages'
      and pg_get_expr(d.adbin, d.adrelid) like '%ack:l:%'
  ) then
    drop index if exists public.sms_messages_dedupe_idx;
    alter table public.sms_messages drop column dedupe_key;

    alter table public.sms_messages
      add column dedupe_key text generated always as (
        case
          when quote_id is not null
           and kind in ('quote', 'nudge_sent', 'nudge_viewed')
            then kind || ':q:' || quote_id::text
          when job_id is not null and kind = 'reminder'
            then 'reminder:j:' || job_id::text
          -- One acknowledgment per lead, forever. Not per day, not per
          -- enquiry: somebody who fills the form in twice has not asked to
          -- be told twice that we got it.
          when lead_id is not null and kind = 'ack'
            then 'ack:l:' || lead_id::text
          else null
        end
      ) stored;

    raise notice 'dedupe_key rebuilt with the ack case.';
  else
    raise notice 'dedupe_key already knows about acks; nothing to do.';
  end if;
end $$;

-- THE PREDICATE MUST MATCH claim_sms()'s ON CONFLICT CLAUSE EXACTLY.
--
-- Three statuses, not two. db/sms.sql created this index over
-- ('queued', 'sent'); db/sms-delivery.sql later widened it to include
-- 'undelivered' and widened claim_sms's ON CONFLICT to match, with a comment
-- saying the two are changed together and never apart.
--
-- Dropping the column to extend it takes the index with it, so this file has
-- to put it back — and the first draft put back the ORIGINAL two-status
-- version. The result was not a subtle drift: ON CONFLICT with no matching
-- index raises outright, so EVERY text the CRM tried to send failed, quotes
-- included. verify/lead-ack.sql caught it on the first run.
drop index if exists public.sms_messages_dedupe_idx;
create unique index sms_messages_dedupe_idx
  on public.sms_messages (dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'sent', 'undelivered');

-- ---------------------------------------------------------------------------
-- 3. Which enquiries are owed an answer
-- ---------------------------------------------------------------------------
--
-- WEBSITE LEADS ONLY, and the reason matters. A lead Hayden types in at
-- somebody's door should NOT get "thanks for reaching out" -- he is standing
-- in front of them. The two are told apart by `source`, and by created_by
-- being null, which is what a row inserted under the anon key looks like.
create or replace function public.sms_due_lead_acks(p_limit int default 25)
returns table (
  out_lead_id  uuid,
  out_name     text,
  out_phone    text,
  out_email    text,
  out_has_sms  boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.name,
    public.sb_sms_e164(l.phone),
    nullif(btrim(l.email), ''),
    public.sb_sms_e164(l.phone) is not null
      and not public.sb_sms_opted_out(public.sb_sms_e164(l.phone))
  from public.leads l
  where l.source = 'website'
    -- Typed by a person means a person was already talking to them.
    and l.created_by is null
    -- The timer.
    and l.created_at <= now() - public.sb_lead_ack_delay()
    -- ... but not so old that answering is worse than not.
    and l.created_at >= now() - public.sb_lead_ack_stale()
    -- Something to reach them on.
    and (
      public.sb_sms_e164(l.phone) is not null
      or nullif(btrim(l.email), '') is not null
    )
    -- Never twice, and never after a person got there first.
    --
    -- ONE condition covers both, deliberately. Any outbound text on this
    -- lead disqualifies it: an acknowledgment we already sent, or a real
    -- reply somebody typed. Neither wants a robot saying "we've got your
    -- message" after it.
    --
    -- There WAS a second condition here checking specifically for a prior
    -- 'ack' row. Mutation testing showed it could be deleted with every
    -- assertion still passing — because an ack IS an outbound text, so this
    -- line already caught it. A condition that cannot fail on its own is
    -- one nobody can reason about, so it went.
    --
    -- Broader than the dedupe index on purpose. That index stops at
    -- 'undelivered', so a 'failed' row leaves it and the message can be
    -- retried after an outage — right for a quote, wrong for this. An
    -- acknowledgment retried hours later is not an acknowledgment of
    -- anything.
    and not exists (
      select 1 from public.sms_messages m
      where m.lead_id = l.id and m.direction = 'out'
    )
    -- The email route is separate because it is a different table, not a
    -- different rule.
    and not exists (
      select 1 from public.sent_emails e
      where e.lead_id = l.id and e.kind = 'ack'
    )
  order by l.created_at
  limit greatest(p_limit, 0)
$$;

comment on function public.sms_due_lead_acks(int) is
  'Website enquiries owed an automatic acknowledgment: older than
   sb_lead_ack_delay(), newer than sb_lead_ack_stale(), reachable, and not
   already answered by anyone or anything.';

revoke all on function public.sms_due_lead_acks(int) from public;
