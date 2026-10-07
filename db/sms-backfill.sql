-- Sky Blue CRM — importing conversations that happened before the CRM saw them
--
-- Run AFTER db/sms-app-messages.sql.
--
-- WHY
-- ---
-- The thread on a lead or customer page reads sms_messages, which holds what
-- the CRM sent plus whatever the webhook captured. The webhook rejected every
-- request Quo ever made to it — a millisecond timestamp against a seconds
-- replay window, see claude/crm-webhook-signature-diagnosis.md — so nothing
-- inbound was ever stored. Every bubble in every thread is one the CRM sent.
-- The other half of each conversation is sitting in Quo.
--
-- Quo's API has it. Importing it needs two things the recorders could not do.
--
-- 1. A TIMESTAMP. record_inbound_sms() stamps now(). Imported through it, a
--    reply from August arrives dated today, lands at the bottom of the
--    thread, and makes every conversation read as though it happened this
--    afternoon. Worse, contact_log gets a "they replied" entry dated today,
--    which is the kind of wrong a person acts on.
--
-- 2. A WAY NOT TO COUNT. record_app_sms() bumps contact_attempts and
--    last_contacted_at, because a person typing a message IS the work and
--    that is the clearest signal the CRM gets that somebody is on a lead.
--    An import is not that. Forty historical messages would add forty to a
--    counter the follow-up automation reads.
--
-- Both are new optional arguments with defaults that preserve exactly what
-- the webhook path does today.
--
-- A third thing came out of writing this: record_inbound_sms() had no
-- ON CONFLICT at all, while db/sms-app-messages.sql put a unique index on
-- provider_sid. A Quo retry of an inbound message therefore raised a unique
-- violation rather than being quietly ignored — the opposite of what the
-- index was added for, and a 500 back to Quo, which retries. Fixed here
-- because an import is a retry by definition.

do $$
begin
  if to_regclass('public.sms_messages') is null then
    raise exception 'Run db/sms.sql and db/sms-app-messages.sql before this file.';
  end if;
  if to_regproc('public.record_app_sms') is null then
    raise exception 'Run db/sms-app-messages.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A reply, with the time it actually arrived
-- ---------------------------------------------------------------------------
drop function if exists public.record_inbound_sms(text, text, text);

create or replace function public.record_inbound_sms(
  p_phone text,
  p_body  text,
  p_sid   text default null,
  -- When it arrived. Null means now, which is what a live webhook means.
  p_at    timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e164   text := public.sb_sms_e164(p_phone);
  digits text := public.sb_phone_digits(p_phone);
  when_  timestamptz := coalesce(p_at, now());
  who    record;
  new_id bigint;
begin
  if e164 is null then
    return null;
  end if;

  who := public.sb_contact_for_phone(p_phone);

  insert into public.sms_messages (
    direction, phone, body, kind, lead_id, customer_id, status, provider_sid,
    -- BOTH COLUMNS, and getting this wrong is the whole feature.
    --
    -- sms_thread() orders on created_at and the bubble is stamped from
    -- created_at. Setting only sent_at fixes a column nothing on the screen
    -- reads: every imported message still appears at the bottom of the
    -- thread with today's date on it, which is precisely the symptom this
    -- migration was written to prevent. Caught by running sms_thread()
    -- against an import rather than by reading the insert.
    --
    -- created_at defaults to now(), and for a live message when_ IS now(),
    -- so the live path is unchanged.
    created_at, sent_at
  )
  values (
    'in', e164, p_body, 'inbound', who.lead_id, who.customer_id, 'received', p_sid,
    when_, when_
  )
  -- THE LINE THAT WAS MISSING. db/sms-app-messages.sql made provider_sid
  -- unique precisely so a retry could not duplicate a message, and then this
  -- function inserted without catching the conflict — so a retry raised,
  -- which became a 500 at Quo, which retries. An import makes that certain
  -- rather than occasional.
  on conflict (provider_sid) where provider_sid is not null do nothing
  returning sms_messages.id into new_id;

  -- Already had it. No second timeline entry, which is the whole point of
  -- being able to run an import twice.
  if new_id is null then
    return null;
  end if;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (who.lead_id, who.customer_id, digits, 'text_in', p_body, when_);

  return new_id;
end;
$$;

comment on function public.record_inbound_sms(text, text, text, timestamptz) is
  'Records one text FROM a customer. p_at is when it arrived; null means now.
   Returns null when the message was already stored.';

-- ---------------------------------------------------------------------------
-- 2. A message somebody sent from the Quo app, optionally without counting it
-- ---------------------------------------------------------------------------
drop function if exists public.record_app_sms(text, text, text, timestamptz);

create or replace function public.record_app_sms(
  p_phone   text,
  p_body    text,
  p_sid     text default null,
  p_sent_at timestamptz default null,
  -- Should this count as somebody reaching out? True for a message that just
  -- happened, false for one being imported from history.
  p_bump    boolean default true
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e164   text := public.sb_sms_e164(p_phone);
  digits text := public.sb_phone_digits(p_phone);
  when_  timestamptz := coalesce(p_sent_at, now());
  who    record;
  new_id bigint;
begin
  if e164 is null then
    return null;
  end if;

  who := public.sb_contact_for_phone(p_phone);

  insert into public.sms_messages (
    direction, phone, body, kind, lead_id, customer_id, status, provider_sid,
    -- See record_inbound_sms above: the thread reads created_at, not sent_at.
    created_at, sent_at
  )
  values (
    'out', e164, p_body, 'app', who.lead_id, who.customer_id, 'sent', p_sid,
    when_, when_
  )
  on conflict (provider_sid) where provider_sid is not null do nothing
  returning sms_messages.id into new_id;

  -- Lost the race to a concurrent webhook retry, or already imported.
  if new_id is null then
    return null;
  end if;

  -- 'text', not 'text_in'. The timeline reads direction from the kind, and
  -- this is Sky Blue talking.
  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (who.lead_id, who.customer_id, digits, 'text', p_body, when_);

  -- THE COUNTERS, and why an import must not touch them.
  --
  -- A person typing a message IS the work, and it is the clearest signal the
  -- CRM gets that somebody is actually on this lead. That reasoning holds
  -- for a message sent a minute ago and collapses for forty messages being
  -- read back out of Quo: the work already happened, and it was already
  -- counted at the time if the CRM was watching. Counting it again would
  -- inflate the number the follow-up automation reads.
  --
  -- greatest() on last_contacted_at either way, so a late-arriving old
  -- message can never drag the date backwards.
  if p_bump and who.lead_id is not null then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, when_), when_),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = who.lead_id;
  end if;

  if p_bump and who.customer_id is not null then
    update public.customers
       set last_contacted_at = greatest(coalesce(last_contacted_at, when_), when_),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = who.customer_id;
  end if;

  return new_id;
end;
$$;

comment on function public.record_app_sms(text, text, text, timestamptz, boolean) is
  'Records one text sent from the Quo app. p_bump false imports it as history
   without counting it as outreach. Returns null when already stored.';

-- ---------------------------------------------------------------------------
-- 3. One door for the importer
-- ---------------------------------------------------------------------------
--
-- So netlify/functions/backfill-texts.mjs holds no opinion about which
-- recorder a message belongs in beyond its direction, and no opinion at all
-- about counters. Everything an import does differently from a live webhook
-- is decided here, in one function, where it can be read.
create or replace function public.import_quo_text(
  p_phone    text,
  p_body     text,
  p_sid      text,
  p_at       timestamptz,
  p_outgoing boolean
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  -- An empty text is a picture, a reaction, or a delivery receipt Quo has
  -- modelled as a message. There is nothing to put in a bubble, and a row of
  -- empty bubbles is worse than a gap.
  if coalesce(btrim(p_body), '') = '' then
    return null;
  end if;

  if p_outgoing then
    return public.record_app_sms(p_phone, p_body, p_sid, p_at, false);
  end if;

  return public.record_inbound_sms(p_phone, p_body, p_sid, p_at);
end;
$$;

revoke all on function public.import_quo_text(text, text, text, timestamptz, boolean)
  from public, anon, authenticated;

comment on function public.import_quo_text(text, text, text, timestamptz, boolean) is
  'One historical text from Quo. Deduped on provider_sid, dated when it
   happened, and never counted as fresh outreach.';

-- ---------------------------------------------------------------------------
-- 4. A page of them at a time
-- ---------------------------------------------------------------------------
--
-- Quo returns messages a hundred to a page, and a hundred separate RPC calls
-- from a Netlify function is a hundred round trips to Supabase inside a
-- request that gets ten seconds. One call per page keeps the import inside
-- its budget and keeps the endpoint free of a retry loop nobody wants to
-- debug.
--
-- Returns how many were NEW, which is the number the screen shows. Rows
-- already stored count as zero rather than as an error: re-importing is the
-- normal way to catch up a conversation that has moved on.
create or replace function public.import_quo_texts(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  n integer := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    -- One bad row must not lose the other ninety-nine. A message with an
    -- unparseable date, or a number that is not a number, is skipped and
    -- named in the log rather than taking the page down with it.
    begin
      if public.import_quo_text(
           r ->> 'phone',
           r ->> 'body',
           r ->> 'sid',
           nullif(r ->> 'at', '')::timestamptz,
           coalesce((r ->> 'outgoing')::boolean, false)
         ) is not null
      then
        n := n + 1;
      end if;
    exception when others then
      raise warning 'import_quo_texts skipped % : %', coalesce(r ->> 'sid', '(no id)'), sqlerrm;
    end;
  end loop;

  return n;
end;
$$;

revoke all on function public.import_quo_texts(jsonb) from public, anon, authenticated;

comment on function public.import_quo_texts(jsonb) is
  'One page of historical texts from Quo, as [{phone, body, sid, at, outgoing}].
   Returns how many were new.';

-- ---------------------------------------------------------------------------
-- 5. Repairing the messages imported before this file was right
-- ---------------------------------------------------------------------------
--
-- The first version of this migration set sent_at and left created_at to its
-- default of now(). sms_thread() orders on created_at and the bubble is
-- stamped from created_at, so those rows are sitting in the table with the
-- right time in a column nothing on the screen reads.
--
-- Re-pressing the button does not fix them. import_quo_text() deduplicates on
-- provider_sid and skips a message it already has — which is the behaviour
-- that makes the button safe to press twice, and exactly why it cannot
-- correct its own earlier mistakes.
--
-- WHY THIS IS SAFE ON EVERY OTHER ROW. It touches only `inbound` and `app`
-- messages — the two kinds the webhook and the importer write — and for a
-- message that arrived live, when_ was now() and both columns were set to the
-- same instant. So this is a no-op on every row except the ones it exists to
-- fix. Everything the CRM itself sent is 'quote', 'manual', 'reminder' and so
-- on, where sent_at is when Quo accepted it and created_at is when it was
-- queued; those are two different facts and this does not touch them.
create or replace function public.repair_imported_text_times()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.sms_messages
     set created_at = sent_at
   where kind in ('inbound', 'app')
     and sent_at is not null
     -- Nothing to do for the overwhelming majority. Also what makes running
     -- this a second time free.
     and created_at is distinct from sent_at;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.repair_imported_text_times() from public, anon, authenticated;

comment on function public.repair_imported_text_times() is
  'Moves imported texts to the time they actually happened. Idempotent, and a
   no-op on anything the CRM sent itself.';

-- Run on apply, so re-running this file is the whole fix.
do $$
declare n integer;
begin
  n := public.repair_imported_text_times();
  if n > 0 then
    raise notice
      '% imported message(s) moved to the time they actually happened.', n;
  else
    raise notice 'No imported messages needed their time corrected.';
  end if;
end $$;
