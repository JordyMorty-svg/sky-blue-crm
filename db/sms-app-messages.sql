-- Sky Blue CRM — keep the texts somebody types in the Quo app
--
-- Run once in the Supabase SQL editor, AFTER db/sms.sql and
-- db/delivery-controls.sql. Safe to re-run. Plain SQL: no psql meta-commands.
--
-- WHAT THIS FIXES
-- ---------------
-- sms_messages already holds every text the CRM sent and every reply a
-- customer sent back. It does NOT hold the ones Hayden or Jordan typed into
-- the Quo app on their phone, and those are most of the real conversation.
--
-- They are not missing because Quo never told us. Quo sends an outbound copy
-- through the same webhook as everything else, and /api/sms-inbound has been
-- receiving them all along:
--
--     if (isDelivered(evt)) { mark_sms_delivered(evt.id); return 200; }
--
-- For a message the CRM sent, that stamps delivered_at and is exactly right.
-- For one typed in the app, mark_sms_delivered matches no row, returns
-- nothing, and the handler returns 200 anyway. The text is dropped on the
-- floor, silently, every time.
--
-- So this adds the other half: record it instead of discarding it.
--
-- THE HARD PART IS NOT RECORDING IT, IT IS NOT RECORDING IT TWICE
-- ---------------------------------------------------------------
-- Every outbound copy looks the same on the wire whether the CRM sent it or
-- a person did. Three ways a duplicate gets in, and all three are handled
-- HERE rather than in the webhook, because the webhook cannot see the table:
--
--   1. The CRM sent it. Matched on provider_sid.
--   2. The CRM sent it and the webhook won the race — Quo's copy arrives
--      before mark_sms_sent() has written the sid, so there is no sid to
--      match on yet. Matched on phone + body inside a short window.
--   3. Quo retried the webhook. Matched on provider_sid again, which is why
--      that column gets a unique index below.
--
-- A duplicate here is not cosmetic: the thread would show the business
-- saying the same thing twice, and contact_attempts would count it twice.

-- ---------------------------------------------------------------------------
-- 0. Dependencies
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.record_inbound_sms(text,text,text)') is null then
    raise exception 'Run db/sms.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. How long an identical message counts as our own echo
-- ---------------------------------------------------------------------------

-- The race in case 2 above is between our own POST to Quo and Quo's webhook
-- coming back. That is seconds, not minutes.
--
-- Deliberately SHORT. Every minute on this window is a minute in which a
-- genuine second "Thanks!" typed in the app gets swallowed as a duplicate.
-- Two minutes covers a very slow round trip and swallows almost nothing;
-- provider_sid does the real work in every case except the race itself.
create or replace function public.sb_sms_echo_window()
returns interval language sql immutable as $$ select interval '2 minutes' $$;

comment on function public.sb_sms_echo_window() is
  'How recently an identical outbound text to the same number counts as the
   CRM''s own message coming back through the webhook, rather than a new one
   somebody typed in the Quo app.';

-- ---------------------------------------------------------------------------
-- 2. One row per provider message id
-- ---------------------------------------------------------------------------

-- Webhooks retry. Without this, a retried delivery copy of an app-sent
-- message inserts a second row every time Quo tries again — and Quo retries
-- on any non-2xx, which is exactly when things are already going wrong.
--
-- Partial, because provider_sid is null until a message is actually sent and
-- stays null forever on one that never was.
do $$
declare
  dup record;
begin
  select provider_sid, count(*) as n
    into dup
  from public.sms_messages
  where provider_sid is not null
  group by provider_sid
  having count(*) > 1
  limit 1;

  if dup.provider_sid is not null then
    raise exception
      'REFUSING. % rows already share provider_sid %. That is a double-send '
      'that predates this file — look at them before adding a unique index '
      'that would make it impossible. Nothing has been changed.',
      dup.n, quote_literal(dup.provider_sid);
  end if;

  if not exists (
    select 1 from pg_class where relname = 'sms_messages_sid_idx'
  ) then
    create unique index sms_messages_sid_idx
      on public.sms_messages (provider_sid)
      where provider_sid is not null;
    raise notice 'provider_sid is now unique; webhook retries cannot duplicate a message.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2b. Matching a number to a person, which has been broken all along
-- ---------------------------------------------------------------------------
--
-- A BUG FOUND WHILE BUILDING THIS, and worse than the thing it was found by.
--
-- record_inbound_sms() matches a reply to a lead or customer with
-- sb_phone_digits(), which strips non-digits and nothing else:
--
--     '5415550101'   -> '5415550101'    (10 digits, how a number is typed in)
--     '+15415550101' -> '15415550101'   (11 digits, how Quo sends it)
--
-- Those never compare equal. Quo puts `from` in E.164, and numbers are typed
-- into the CRM off a door hanger without a country code — so a customer's
-- reply is written to sms_messages and contact_log with lead_id and
-- customer_id NULL. It is on file and it is attached to nobody: invisible on
-- their timeline, invisible to anything that asks "has this lead replied".
--
-- Proven, not inferred. Against a customer stored as '5415550101':
--     record_inbound_sms('5415550101',  ...) -> attached
--     record_inbound_sms('+15415550101', ...) -> orphaned
--
-- The fix is to compare on the ten digits that identify a US number,
-- whichever way either side happens to be written.
create or replace function public.sb_phone_key(p text)
returns text
language sql
immutable
as $$
  select case
    -- 11 digits starting with the country code: drop it.
    when public.sb_phone_digits(p) ~ '^1[2-9][0-9]{9}$'
      then right(public.sb_phone_digits(p), 10)
    when public.sb_phone_digits(p) ~ '^[2-9][0-9]{9}$'
      then public.sb_phone_digits(p)
    -- Anything else is returned as-is rather than mangled: an extension, an
    -- international number, or a note somebody typed in the phone field will
    -- simply fail to match, which is the honest outcome.
    else public.sb_phone_digits(p)
  end
$$;

comment on function public.sb_phone_key(text) is
  'The ten digits that identify a US number, for comparing a stored phone
   against one a provider sent in E.164. sb_phone_digits() alone does not:
   it leaves the leading 1 on, so +1541... never equals 541...';

grant execute on function public.sb_phone_key(text) to service_role;
grant execute on function public.sb_phone_key(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Who a phone number belongs to
-- ---------------------------------------------------------------------------

-- One lookup, used by every path that has to answer "whose message is this".
--
-- record_inbound_sms() is redefined below to call this instead of carrying its
-- own copy. That does mean a db/sms.sql function is being replaced from
-- another file, which normally leaves two definitions in the repo with only
-- the run order deciding which is real. It is the lesser evil here: db/sms.sql
-- cannot simply be edited and re-run, because the copy of claim_sms() in it
-- predates db/sms-delivery.sql and re-running it would put the two-status
-- ON CONFLICT clause back — which matches no index and makes EVERY text the
-- CRM sends fail. Redefining one small function from here is recoverable;
-- re-running that file is not.
create or replace function public.sb_contact_for_phone(
  p_phone text,
  out lead_id uuid,
  out customer_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  key text := public.sb_phone_key(p_phone);
begin
  if key is null then
    return;
  end if;

  -- Most recent match wins. Someone who has been a lead twice and a customer
  -- once should have their message land on the record being worked today,
  -- not the one from March.
  -- `id desc` is a tiebreak, not an ordering anyone should read meaning into.
  -- It only decides anything when two rows share a created_at, which happens
  -- when both were written in the same transaction — now() is fixed for its
  -- duration. Arbitrary-but-stable beats arbitrary: without it the same
  -- lookup can return a different record on consecutive calls, and a reply
  -- would wander between two leads for no visible reason.
  select c.id into customer_id
    from public.customers c
   where public.sb_phone_key(c.phone) = key
   order by c.created_at desc, c.id desc
   limit 1;

  select l.id into lead_id
    from public.leads l
   where public.sb_phone_key(l.phone) = key
   order by l.created_at desc, l.id desc
   limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3b. The inbound path, using the same lookup
-- ---------------------------------------------------------------------------

-- Same function as db/sms.sql, with the matching replaced. Everything else is
-- unchanged, including 'text_in' on the timeline — a reply shown as outreach
-- would make the history read as though Sky Blue said something it never did.
--
-- This is what stops customer replies being filed against nobody. It does not
-- repair the ones already orphaned; section 6 does that.
create or replace function public.record_inbound_sms(
  p_phone text,
  p_body  text,
  p_sid   text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e164   text := public.sb_sms_e164(p_phone);
  digits text := public.sb_phone_digits(p_phone);
  who    record;
  new_id bigint;
begin
  if e164 is null then
    return null;
  end if;

  who := public.sb_contact_for_phone(p_phone);

  insert into public.sms_messages (
    direction, phone, body, kind, lead_id, customer_id, status, provider_sid, sent_at
  )
  values (
    'in', e164, p_body, 'inbound', who.lead_id, who.customer_id, 'received', p_sid, now()
  )
  returning sms_messages.id into new_id;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (who.lead_id, who.customer_id, digits, 'text_in', p_body, now());

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Recording one
-- ---------------------------------------------------------------------------

-- Returns the new row's id, or NULL when it decided this message is already
-- on file. The webhook calls it for every outbound copy and does not try to
-- work out which ones are ours — that judgement lives here, next to the table
-- it depends on.
create or replace function public.record_app_sms(
  p_phone text,
  p_body  text,
  p_sid   text default null,
  p_sent_at timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e164    text := public.sb_sms_e164(p_phone);
  digits  text := public.sb_phone_digits(p_phone);
  who     record;
  new_id  bigint;
  when_   timestamptz := coalesce(p_sent_at, now());
begin
  if e164 is null or coalesce(btrim(p_body), '') = '' then
    return null;
  end if;

  -- 1 and 3 — the CRM sent it, or Quo retried — are both answered by the
  -- unique index on provider_sid and the ON CONFLICT below, not here.
  --
  -- There WAS an explicit `if exists (... where provider_sid = p_sid)` check
  -- at this point. Mutation testing deleted it and every assertion still
  -- passed, because the insert hits the index and returns null anyway, and
  -- nothing after the insert runs. A condition that cannot fail on its own is
  -- one nobody can reason about, so it went — and the guard that was actually
  -- doing the work is now the only one, which is also the one that holds when
  -- two webhooks arrive at once.
  --
  -- 2 is different and does need code: the race. The CRM sent this seconds ago
  -- and has not written the sid yet, so there is nothing to match on but the
  -- words.
  if exists (
    select 1 from public.sms_messages m
    where m.direction = 'out'
      and m.phone = e164
      and m.body = p_body
      and m.created_at >= now() - public.sb_sms_echo_window()
  ) then
    return null;
  end if;

  who := public.sb_contact_for_phone(p_phone);

  -- kind 'manual', which is what a person typing a message has always been
  -- called here, and which produces a NULL dedupe_key — so two identical
  -- messages typed deliberately are both kept. sent_by stays null: Quo's
  -- webhook identifies the workspace, not which brother was holding the
  -- phone, and inventing an author is worse than admitting we do not know.
  insert into public.sms_messages (
    direction, phone, body, kind, lead_id, customer_id,
    status, provider_sid, created_at, sent_at
  )
  values (
    'out', e164, p_body, 'manual', who.lead_id, who.customer_id,
    'sent', p_sid, when_, when_
  )
  on conflict (provider_sid) where provider_sid is not null do nothing
  returning sms_messages.id into new_id;

  -- Lost the race to a concurrent webhook retry. Not an error.
  if new_id is null then
    return null;
  end if;

  -- 'text', not 'text_in'. The timeline reads direction from the kind, and
  -- this is Sky Blue talking.
  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (who.lead_id, who.customer_id, digits, 'text', p_body, when_);

  -- Bumped, unlike an automatic text.
  --
  -- mark_sms_sent() bumps these for everything the CRM sends; the follow-up
  -- email deliberately does not, because an automation should not make a
  -- quiet customer look worked. A person typing a message is the opposite
  -- case: that IS the work, and it is the clearest signal the CRM gets that
  -- somebody is actually on this lead.
  if who.lead_id is not null then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, when_), when_),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = who.lead_id;
  end if;

  if who.customer_id is not null then
    update public.customers
       set last_contacted_at = greatest(coalesce(last_contacted_at, when_), when_),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = who.customer_id;
  end if;

  return new_id;
end;
$$;

comment on function public.record_app_sms(text, text, text, timestamptz) is
  'Record a text somebody typed in the Quo app, so the CRM thread is the whole
   conversation and not just the half it sent itself. Returns null when the
   message is already on file — the caller does not have to know which ones
   are its own.';

grant execute on function public.record_app_sms(text, text, text, timestamptz) to service_role;
grant execute on function public.sb_contact_for_phone(text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Reattaching the replies that were filed against nobody
-- ---------------------------------------------------------------------------
--
-- Every reply that arrived from a customer whose number is stored without a
-- country code is sitting in sms_messages and contact_log with null ids. The
-- rows are intact; only the link is missing, so it can simply be recomputed.
--
-- Only fills in what is NULL. A row already attached to a lead or customer is
-- left exactly as it is, because the alternative is this migration quietly
-- moving a historical message onto a different record.
do $$
declare
  fixed_m int;
  fixed_c int;
begin
  -- Worked out in a SELECT first, then joined back by id.
  --
  -- The obvious `update ... from lateral f(m.phone)` is rejected: an UPDATE's
  -- target table is not a lateral source for its own FROM clause, and the
  -- error ("invalid reference to FROM-clause entry") does not say so.
  with targets as (
    select m.id, w.lead_id as new_lead, w.customer_id as new_cust
    from public.sms_messages m
    cross join lateral public.sb_contact_for_phone(m.phone) w
    -- Only rows the repair would actually CHANGE. The looser
    -- "missing either id, found either id" counts a message that already has
    -- a customer and was never going to gain a lead, so the notice reports
    -- more repairs than it made — and that number is the only evidence
    -- anybody has that this worked.
    where (m.lead_id is null and w.lead_id is not null)
       or (m.customer_id is null and w.customer_id is not null)
  ),
  repaired as (
    update public.sms_messages m
       set lead_id     = coalesce(m.lead_id, t.new_lead),
           customer_id = coalesce(m.customer_id, t.new_cust)
      from targets t
     where t.id = m.id
    returning 1
  )
  select count(*) into fixed_m from repaired;

  with targets as (
    select c.id, w.lead_id as new_lead, w.customer_id as new_cust
    from public.contact_log c
    cross join lateral public.sb_contact_for_phone(c.phone_norm) w
    where c.phone_norm is not null
      and ( (c.lead_id is null and w.lead_id is not null)
         or (c.customer_id is null and w.customer_id is not null) )
  ),
  repaired as (
    update public.contact_log c
       set lead_id     = coalesce(c.lead_id, t.new_lead),
           customer_id = coalesce(c.customer_id, t.new_cust)
      from targets t
     where t.id = c.id
    returning 1
  )
  select count(*) into fixed_c from repaired;

  raise notice
    'Reattached % message(s) and % timeline entr(ies) that were filed against nobody.',
    fixed_m, fixed_c;
end $$;

-- ---------------------------------------------------------------------------
-- 7. What the threads look like now
-- ---------------------------------------------------------------------------

select
  m.direction,
  m.kind,
  count(*) as messages
from public.sms_messages m
group by m.direction, m.kind
order by m.direction, count(*) desc;
