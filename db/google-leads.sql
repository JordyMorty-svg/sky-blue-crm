-- Sky Blue CRM — leads Google sends us, in the CRM with everything else
--
-- Run AFTER db/sms-app-messages.sql (for sb_contact_for_phone and
-- sb_phone_key) and db/contact-history.sql (for contact_log).
--
-- WHAT THIS IS FOR
-- ----------------
-- Local Services Ads is pay-per-lead: Google charges for a call, a message or
-- a booking, and those leads live in Google's own inbox. Nothing brings them
-- here, so the one channel Sky Blue pays per-lead for is the one channel the
-- CRM cannot see — and "revenue by lead source" is missing the source with a
-- price tag attached.
--
-- HALF OF IT MAY ALREADY ARRIVE. An LSA phone lead rings a Google forwarding
-- number which routes to whatever is on the Business Profile. If that is the
-- Quo number, the CALL is already in contact_log via db/call-outcome.sql,
-- filed against the caller's number by sb_contact_for_phone(). What is
-- missing is who they are and what they asked for.
--
-- That shapes the whole design: this must ATTACH to whoever already owns that
-- number rather than create a second record beside them. A lead and a mystery
-- phone call sitting side by side is worse than either alone.
--
-- WHY A SEPARATE TABLE. google_leads holds what belongs to Google — their
-- lead id, what they charged, which category they matched. leads holds what
-- belongs to Sky Blue. Putting a provider's id on the leads table is how
-- `leads` slowly becomes a column per advertising channel.

do $$
begin
  if to_regproc('public.sb_contact_for_phone') is null then
    raise exception 'Run db/sms-app-messages.sql before this file.';
  end if;
  if to_regclass('public.contact_log') is null then
    raise exception 'Run db/contact-history.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. What Google told us
-- ---------------------------------------------------------------------------
create table if not exists public.google_leads (
  -- Google's own id for the lead, from the resource name
  -- customers/{cid}/localServicesLeads/{id}. The primary key, because a
  -- scheduled poll re-reads the same window and the one thing that must never
  -- happen is the same lead arriving twice as two people.
  google_lead_id text primary key,

  -- Who it ended up attached to. Both nullable: a lead whose contact details
  -- Google has wiped has nobody to attach to, and is still worth keeping so
  -- the charge can be reconciled.
  lead_id        uuid references public.leads(id) on delete set null,
  customer_id    uuid references public.customers(id) on delete set null,

  -- PHONE_CALL | MESSAGE | BOOKING, as Google spells it. Stored raw: this is
  -- somebody else's vocabulary and it has changed once already.
  lead_type      text,
  category_id    text,
  service_id     text,
  lead_status    text,

  -- THE MONEY. lead_charged is what makes this table worth having beyond the
  -- lead itself: it is the only place the CRM can see what Google billed for
  -- a name, and therefore whether the channel pays.
  charged        boolean,

  phone_norm     text,
  created_at     timestamptz not null default now(),
  -- When GOOGLE says it happened, not when we noticed. A poll that runs every
  -- hour must not stamp an 08:05 lead as 09:00.
  lead_at        timestamptz
);

create index if not exists google_leads_lead_idx on public.google_leads (lead_id);
create index if not exists google_leads_customer_idx on public.google_leads (customer_id);
create index if not exists google_leads_at_idx on public.google_leads (lead_at desc);

-- ---------------------------------------------------------------------------
-- 2. The newest lead Google has given us
-- ---------------------------------------------------------------------------
--
-- So the poll can ask for "anything since" instead of re-reading a fixed
-- window and hoping it is wide enough. Returns null on an empty table, which
-- the caller reads as "first run, go back far enough to catch up".
--
-- Deliberately NOT a stored cursor. A cursor is a second fact that can
-- disagree with the data, and the disagreement is silent: set it forward by a
-- bug and the leads in the gap are never fetched and never missed. The newest
-- row IS the high-water mark.
create or replace function public.latest_google_lead_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select max(lead_at) from public.google_leads
$$;

-- ---------------------------------------------------------------------------
-- 3. Recording one
-- ---------------------------------------------------------------------------
create or replace function public.record_google_lead(
  p_google_lead_id text,
  p_name           text default null,
  p_phone          text default null,
  p_email          text default null,
  p_at             timestamptz default null,
  p_lead_type      text default null,
  p_category       text default null,
  p_service        text default null,
  p_status         text default null,
  p_charged        boolean default null,
  -- A sentence for the timeline: what they asked for, in Google's words.
  p_detail         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  when_    timestamptz := coalesce(p_at, now());
  digits   text := public.sb_phone_digits(p_phone);
  who      record;
  lead_out uuid;
  cust_out uuid;
  existed  boolean;
begin
  if coalesce(btrim(p_google_lead_id), '') = '' then
    -- No id means no dedupe, and no dedupe means every poll re-creates every
    -- lead. Refusing is better than the thing this table exists to prevent.
    return null;
  end if;

  -- ALREADY HAVE IT. The ordinary case: the poll overlaps its own window on
  -- purpose, so most of what it reads has been read before. Not an error, and
  -- the caller counts a null as "nothing new" rather than a failure.
  select true into existed from public.google_leads
   where google_lead_id = p_google_lead_id;
  if existed then
    return null;
  end if;

  -- WHOSE NUMBER IS THIS. The whole reason this runs before the insert.
  --
  -- An LSA phone lead has usually already rung the Quo number, so there is a
  -- call on somebody's timeline and possibly a lead from the website too.
  -- Creating a second record for the same human would split one conversation
  -- across two pages and leave both looking half-answered.
  if p_phone is not null then
    who := public.sb_contact_for_phone(p_phone);
    lead_out := who.lead_id;
    cust_out := who.customer_id;
  end if;

  -- Nobody owns the number, and there is a number to own. A new lead, marked
  -- with where it came from and what it cost.
  if lead_out is null and cust_out is null and digits is not null then
    -- SOURCE IS NOT SET HERE. The update a few lines below sets it for every
    -- lead this function touches, new or existing, so setting it twice would
    -- leave a value that can never be observed — and a mutation run proved
    -- exactly that: changing it to 'google' broke nothing, because the update
    -- put it back. A value that cannot fail on its own is one nobody can
    -- reason about later.
    insert into public.leads (name, phone, email, status)
    values (
      -- NO NAME IS THE COMMON CASE, not the exception. Of the first seven
      -- leads on this account, five carried only a phone number.
      --
      -- So the placeholder has to be DISTINGUISHABLE. "Google lead" five
      -- times over is a board of identical rows nobody can tell apart or
      -- search for; "Google lead · 6330" is the same honest placeholder and
      -- names which one it is. Last four digits, the way every log line and
      -- every other screen in this CRM refers to a number.
      coalesce(
        nullif(btrim(coalesce(p_name, '')), ''),
        case when digits is not null then 'Google lead · ' || right(digits, 4)
             else 'Google lead' end
      ),
      p_phone,
      nullif(btrim(coalesce(p_email, '')), ''),
      'new'
    )
    returning id into lead_out;
  end if;

  -- An EXISTING record may be missing what Google just told us. Filled in,
  -- never overwritten: a name somebody typed is better than a name an ad
  -- platform guessed, and a blank field is the only safe thing to write into.
  if lead_out is not null then
    update public.leads
       -- `like 'Google lead%'` so the numbered placeholders are replaced too.
       -- Matching the bare string only would have left "Google lead · 6330"
       -- in place forever, which is the shape of bug where a fix to the
       -- placeholder quietly disables the thing that clears it.
       -- THE SOURCE IS CORRECTED, and it is the one field here that
       -- overwrites something a person chose.
       --
       -- Deliberate. Google charged for this lead, so Google knows where it
       -- came from; a human marking it 'door' or 'website' was guessing after
       -- the fact, and 'door' is also what a lead gets by default when nobody
       -- picks anything at all. Leaving it alone means "revenue by lead
       -- source" credits the free channel for leads the paid one delivered —
       -- which is the single question this whole feature exists to answer.
       --
       -- The timeline keeps the receipt either way: the google_lead entry
       -- says when it arrived and what it was.
       -- 'lsa', the key LEAD_SOURCES in src/services/leadService.js already
       -- uses — NOT a new one. The first draft wrote 'google_lsa' and
       -- invented a second name for a channel the CRM had already named;
       -- sourceFor() shows an unknown key as its raw string, so the board
       -- would have read "google_lsa" beside leads labelled "Google Ads
       -- (LSA)" and every report would have split one channel in two.
       --
       -- Deliberately not 'google' either: organic Google is free and LSA is
       -- charged per lead whether or not the customer ever replies. Averaged
       -- together, revenue by source cannot answer the only question worth
       -- asking of a paid channel.
       set source = 'lsa',
           name  = case when coalesce(btrim(name), '') = ''
                          or coalesce(btrim(name), '') like 'Google lead%'
                        then coalesce(nullif(btrim(coalesce(p_name, '')), ''), name)
                        else name end,
           email = coalesce(nullif(btrim(coalesce(email, '')), ''), nullif(btrim(coalesce(p_email, '')), '')),
           phone = coalesce(nullif(btrim(coalesce(phone, '')), ''), p_phone)
     where id = lead_out;
  end if;

  insert into public.google_leads (
    google_lead_id, lead_id, customer_id, lead_type, category_id, service_id,
    lead_status, charged, phone_norm, lead_at
  )
  values (
    p_google_lead_id, lead_out, cust_out, p_lead_type, p_category, p_service,
    p_status, p_charged, digits, when_
  )
  -- Two polls overlapping in the same second. The select above catches the
  -- ordinary repeat; this catches the race, and both mean "already had it".
  on conflict (google_lead_id) do nothing;

  if not found then
    return null;
  end if;

  -- THE TIMELINE ENTRY, and it is the point of the whole exercise.
  --
  -- Without it, a lead that Google charged for looks identical on the page to
  -- one somebody met at a door. The kind is its own value rather than reusing
  -- 'note', because what you do next differs: a paid lead is waiting for a
  -- call back right now.
  if lead_out is not null or cust_out is not null then
    insert into public.contact_log (
      lead_id, customer_id, phone_norm, kind, detail, created_at
    )
    values (
      lead_out, cust_out, digits, 'google_lead',
      coalesce(nullif(btrim(coalesce(p_detail, '')), ''),
               'Google Local Services lead'),
      when_
    );
  end if;

  return lead_out;
end;
$$;

revoke all on function public.record_google_lead(
  text, text, text, text, timestamptz, text, text, text, text, boolean, text)
  from public, anon, authenticated;

comment on function public.record_google_lead(
  text, text, text, text, timestamptz, text, text, text, text, boolean, text) is
  'Records one Local Services lead, attaching it to whoever already owns that
   phone number rather than creating a second record. Returns the lead id, or
   null when the lead was already known.';

-- ---------------------------------------------------------------------------
-- 4. A page of them
-- ---------------------------------------------------------------------------
--
-- One call per poll rather than one per lead: a Netlify function gets ten
-- seconds, and a round trip each for twenty leads spends most of it waiting.
create or replace function public.record_google_leads(p_rows jsonb)
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
    -- One malformed lead must not lose the other nineteen. Named in the log
    -- rather than taking the page down.
    begin
      if public.record_google_lead(
           r ->> 'id',
           r ->> 'name',
           r ->> 'phone',
           r ->> 'email',
           nullif(r ->> 'at', '')::timestamptz,
           r ->> 'type',
           r ->> 'category',
           r ->> 'service',
           r ->> 'status',
           case when r ? 'charged' then (r ->> 'charged')::boolean end,
           r ->> 'detail'
         ) is not null
      then
        n := n + 1;
      end if;
    exception when others then
      raise warning 'record_google_leads skipped % : %',
        coalesce(r ->> 'id', '(no id)'), sqlerrm;
    end;
  end loop;

  return n;
end;
$$;

revoke all on function public.record_google_leads(jsonb) from public, anon, authenticated;

comment on function public.record_google_leads(jsonb) is
  'One page of Local Services leads as [{id, name, phone, email, at, type,
   category, service, status, charged, detail}]. Returns how many were new.';
