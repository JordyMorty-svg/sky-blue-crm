-- Sky Blue CRM — the conversation, as one thread
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Everything needed to show a text conversation on a lead or customer page
-- already exists: sms_messages holds both directions, record_app_sms() keeps
-- the ones typed in the Quo app, and claim_sms() sends a new one. What was
-- missing is a way to ASK for a conversation.
--
-- THE THREAD IS KEYED ON THE PHONE NUMBER, not on the lead or the customer.
--
-- That is the whole design decision in this file and it is worth stating
-- plainly, because the obvious alternative — one thread per record — is
-- wrong in a way that only shows up months later. One person in this CRM is
-- routinely three rows: a lead from the door-knock in April, a second lead
-- from the website form in June, and a customer row once they booked. Keyed
-- on the record, the conversation splits three ways and the page you happen
-- to be on decides which third of it you can read. Keyed on the number,
-- there is one conversation with one human, which is also how it looks on
-- the phone in their pocket.
--
-- The cost of that choice is a household sharing a landline looks like one
-- thread. It already does in Quo, and in the Messages app, and on the
-- handset — so this matches what everyone involved already believes.
--
-- Matching is sb_phone_key(), from db/sms-app-messages.sql, NOT
-- sb_phone_digits(). The difference is the bug that file fixed: the leads
-- table holds "5415550101" because somebody typed it, sms_messages holds
-- "+15415550101" because that is what claim_sms() normalises to, and
-- sb_phone_digits gives "5415550101" and "15415550101" — which are not
-- equal, so every reply in the database was invisible to every lookup that
-- went looking for it. A thread built on sb_phone_digits would come back
-- empty for every customer and look like "we have never texted anybody".

-- ---------------------------------------------------------------------------
-- 0. What has to be there first
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.sb_phone_key(text)') is null then
    raise exception
      'Run db/sms-app-messages.sql before this file. The thread matches on '
      'sb_phone_key(), which is what makes "+15415550101" and "5415550101" '
      'the same person; without it every thread comes back empty.';
  end if;

  if to_regclass('public.sms_messages') is null then
    raise exception 'Run db/sms.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The conversation
-- ---------------------------------------------------------------------------

-- Dropped first. `create or replace` cannot change a function's return type
-- — it fails outright — and this one will gain columns as the thread UI
-- grows. Dropping the exact signature is also what stops a changed argument
-- list creating a silent SECOND overload that PostgREST then picks between
-- by guessing.
drop function if exists public.sms_thread(text, integer);

create or replace function public.sms_thread(
  p_phone text,
  -- Newest N, then reversed into reading order below. A number texted every
  -- week for two years should not send three hundred rows to a phone on a
  -- driveway; the composer only ever needs the recent end of the
  -- conversation, and "load older" can come later if anyone ever wants it.
  p_limit integer default 50
)
returns table (
  id           bigint,
  direction    text,
  body         text,
  kind         text,
  status       text,
  created_at   timestamptz,
  sent_at      timestamptz,
  delivered_at timestamptz,
  error        text,
  -- Who typed it, when a person did. Null for the automatic sends and for
  -- anything that came in from the Quo app, where Quo knows the author and
  -- this database does not.
  sent_by      text,
  provider_sid text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  key text;
begin
  key := public.sb_phone_key(p_phone);

  -- NO GUARD HERE, AND THAT IS A DECISION. Read this before adding one.
  --
  -- The worry is real: a lookup for a number that is not a number must
  -- match nothing, and must on no account match EVERYTHING. This panel
  -- shows a private conversation on somebody's record, and one stranger's
  -- text in it is a far worse bug than a missing one.
  --
  -- It is already safe, for a reason that lives in another file.
  -- sb_phone_digits() returns NULL rather than '' when a string has no
  -- digits in it, so sb_phone_key('') and sb_phone_key('ask for Dave') are
  -- both NULL, and `where sb_phone_key(m.phone) = null` is false for every
  -- row including the junk ones. An `if key is null then return` on top of
  -- that is a condition that cannot fail, which is the kind nobody can
  -- reason about later — the first draft had one, justified in a comment
  -- by a claim about sb_phone_key('') that was simply not true.
  --
  -- What protects this instead is an assertion. verify/sms-thread.sql
  -- checks the PREMISE — that a digitless string keys to null and matches
  -- nothing — so the day somebody makes sb_phone_digits() return an empty
  -- string, this suite goes red rather than a stranger's text quietly
  -- appearing in a customer's thread.
  return query
  select *
  from (
    select m.id,
           m.direction,
           m.body,
           m.kind,
           m.status,
           m.created_at,
           m.sent_at,
           -- delivered_at is added by db/delivery-controls.sql. Read through
           -- to_jsonb rather than named directly so this file still
           -- installs against a database that has not run that one — a
           -- missing COLUMN is a hard parse error at create time, which
           -- would make this whole function refuse to exist rather than
           -- just lose one timestamp.
           (to_jsonb(m) ->> 'delivered_at')::timestamptz,
           m.error,
           p.full_name,
           m.provider_sid
    from public.sms_messages m
    left join public.profiles p on p.id = m.sent_by
    where public.sb_phone_key(m.phone) = key
    order by m.created_at desc, m.id desc
    limit greatest(coalesce(p_limit, 50), 1)
  ) recent
  -- Oldest first, like every other thread anybody has ever read.
  order by recent.created_at asc, recent.id asc;
end;
$$;

comment on function public.sms_thread(text, integer) is
  'One conversation with one human, both directions, oldest first. Keyed on
   the phone number rather than the lead or customer row, because the same
   person is routinely several rows and the conversation is not.';

grant execute on function public.sms_thread(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Which number a page is actually talking to
-- ---------------------------------------------------------------------------

-- The page has a phone in a text box. That is the right number to use and
-- this function is NOT about second-guessing it.
--
-- It exists for the other half: given the number, which lead and which
-- customer should a new message be stamped with? The send endpoint is handed
-- a lead id or a customer id by whichever page called it, and stamping only
-- that one leaves the message off the other's history — the same split this
-- file exists to avoid, reintroduced at the moment of writing.
--
-- contact_identity() already resolves a person three ways. This is a thin
-- read of it that answers in the shape the sender needs.
drop function if exists public.sms_thread_ids(uuid, uuid);

create or replace function public.sms_thread_ids(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (lead_id uuid, customer_id uuid, phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ident record;
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  return query
  select
    -- The id we were handed wins. It is the record the person is looking at,
    -- and when somebody has two leads the one on screen is the one they mean.
    coalesce(p_lead_id, (select x from unnest(ident.lead_ids) x limit 1)),
    coalesce(p_customer_id, (select x from unnest(ident.customer_ids) x limit 1)),
    ident.phone;
end;
$$;

grant execute on function public.sms_thread_ids(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reading a thread is not the same as being allowed to send one
-- ---------------------------------------------------------------------------

-- Both functions above are read-only and granted to any signed-in user,
-- matching contact_timeline(). SENDING stays where it already is: behind
-- claim_sms(), behind the Netlify endpoint, behind SMS_MODE, and behind the
-- opt-out check that has no override. Nothing in this file can send a text.
