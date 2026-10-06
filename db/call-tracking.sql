-- Sky Blue CRM — a call is logged when a call happened, and not before
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- THE BUG THIS FIXES
-- ------------------
-- The Call button on the lead page and the customer page did two things at
-- once: it followed a tel: link, and it called record_lead_contact(). The
-- second one did not wait to find out whether the first one worked.
--
-- So on a laptop, where tel: opens nothing at all, pressing Call logged a
-- call. On a phone, where tel: opens the dialler, pressing Call and then
-- pressing cancel logged a call. Misdialling logged a call. Ringing out
-- logged a call. Every one of those wrote "Called" onto the customer's
-- history, bumped contact_attempts, and moved a new lead to Contacted.
--
-- contact_attempts is the number the follow-up automation reads and the
-- number a person reads before deciding whether to chase somebody again.
-- It was counting button presses. "Three attempts, no answer" and "pressed
-- a button three times" are not the same fact, and the CRM could not tell
-- them apart.
--
-- THE FIX
-- -------
-- Quo knows. It placed the call, it knows whether it connected, and it
-- knows for how long — and it will say so on a `call.completed` webhook
-- carrying status and duration. So the button stops writing anything and
-- becomes a handoff to Quo, and the webhook writes the row.
--
-- What that buys, beyond honesty: calls placed from the Quo app WITHOUT
-- touching the CRM now appear too. Hayden ringing a customer back from his
-- phone on the way to a job has never been in this database. From here on
-- it is, with its real duration, on the right person's history.
--
-- WHAT COUNTS AS A CALL
-- ---------------------
-- Quo's `call.completed` reports one of: answered, unanswered, failed,
-- forwarded, abandoned, ai-handled, unknown — plus a duration in seconds.
--
--   connected  — somebody picked up and there was a conversation. This is
--                the one that advances a new lead to contacted, because it
--                is the only one where you actually spoke to them.
--   attempted  — it rang and nobody answered. Still a real outbound call,
--                still worth counting as an attempt, but it does NOT move
--                anybody down the funnel. "I rang, no answer" is not
--                "contacted".
--   missed     — they rang US and we did not pick up. Logged, because a
--                customer trying to reach you is the single most useful
--                thing this timeline can tell you, and it has never been in
--                here at all.
--
-- A failed or abandoned call is not logged. Nothing happened: the network
-- refused it, or the caller hung up before it rang. Writing those down is
-- the old behaviour wearing a different hat.

-- ---------------------------------------------------------------------------
-- 0. What has to be there first
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.contact_log') is null
     or to_regprocedure('public.record_contact(uuid,uuid,text,text)') is null then
    raise exception 'Run db/contact-history.sql before this file.';
  end if;

  if to_regprocedure('public.sb_contact_for_phone(text)') is null then
    raise exception
      'Run db/sms-app-messages.sql before this file. Attaching a call to a '
      'person uses sb_contact_for_phone(), and the sb_phone_key() matching '
      'underneath it is what makes "+15415550101" and "5415550101" the same '
      'number — without it every call lands against nobody.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. What the log can now record about a call
-- ---------------------------------------------------------------------------

alter table public.contact_log
  -- Quo's own id for the call. THE DEDUPE KEY, and the reason this file can
  -- be safe about webhook retries: Quo delivers at least once and retries
  -- anything that is not a 2xx, so without this one customer ringing once
  -- becomes four rows on their history.
  add column if not exists provider_call_id text,
  -- 'out' when we rang them, 'in' when they rang us. The timeline has never
  -- been able to say which, because a button press only ever meant one.
  add column if not exists direction        text,
  -- As Quo reported it, so a row can be re-read later without trusting this
  -- file's interpretation of it.
  add column if not exists outcome          text,
  add column if not exists duration_seconds integer;

-- Unique over the ids we actually have. A partial index rather than a plain
-- unique constraint because every row written before today — and every note
-- typed by hand after it — has no provider_call_id, and a plain constraint
-- would allow exactly one of them.
create unique index if not exists contact_log_call_id_idx
  on public.contact_log (provider_call_id)
  where provider_call_id is not null;

-- ---------------------------------------------------------------------------
-- 1b. One person, however their number was typed
-- ---------------------------------------------------------------------------
--
-- FOUND WHILE TESTING THE ABOVE, and it is the same bug
-- db/sms-app-messages.sql fixed for texts, still live over here.
--
-- contact_identity() is what decides which leads and which customers are
-- the same human. It matches them on sb_phone_digits(), which strips
-- everything that is not a digit and stops. So a lead whose phone was typed
-- "(541) 555-0101" keys to 5415550101, and the SAME PERSON entered a second
-- time as "+1 541 555 0101" keys to 15415550101 — and those are not equal.
--
-- One human, two records, and the CRM cannot tell. Their history splits in
-- half down the middle, a call logged against one is invisible from the
-- other, and now that calls arrive from a webhook carrying an E.164 number
-- it would get worse rather than better.
--
-- sb_phone_key() is the fix: it drops a leading US country code before
-- comparing, so both spellings key to 5415550101.
--
-- MATCHING changes; the RETURNED phone does not. contact_log.phone_norm
-- holds whatever sb_phone_digits() gave at the time it was written, and
-- contact_timeline() falls back to comparing against it for rows that have
-- no lead or customer id. Changing what this function returns would break
-- that comparison for every row already in the table — so the join gets
-- cleverer and the stored value stays exactly what it was.
drop function if exists public.contact_identity(uuid, uuid);

create or replace function public.contact_identity(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (lead_ids uuid[], customer_ids uuid[], phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ph    text;
  k     text;
  leads_out     uuid[] := '{}';
  customers_out uuid[] := '{}';
begin
  select sb_phone_digits(l.phone) into ph from public.leads l where l.id = p_lead_id;
  if ph is null then
    select sb_phone_digits(c.phone) into ph from public.customers c where c.id = p_customer_id;
  end if;

  -- The comparison key. Null when there is no number, and `= null` is false
  -- for every row — so a lead with no phone matches nobody rather than
  -- matching everybody with no phone, which is a large and arbitrary group.
  k := public.sb_phone_key(ph);

  select coalesce(array_agg(distinct id), '{}') into leads_out
  from (
    select l.id from public.leads l where l.id = p_lead_id
    union
    select l.id from public.leads l
      where k is not null and public.sb_phone_key(l.phone) = k
    union
    select j.lead_id from public.jobs j
      where j.lead_id is not null
        and (j.customer_id = p_customer_id
             or j.lead_id = p_lead_id
             or j.customer_id in (select cc.id from public.customers cc
                                  where k is not null
                                    and public.sb_phone_key(cc.phone) = k))
  ) s;

  select coalesce(array_agg(distinct id), '{}') into customers_out
  from (
    select c.id from public.customers c where c.id = p_customer_id
    union
    select c.id from public.customers c
      where k is not null and public.sb_phone_key(c.phone) = k
    union
    select j.customer_id from public.jobs j
      where j.customer_id is not null
        and (j.lead_id = p_lead_id or j.lead_id = any(leads_out))
  ) s;

  -- sb_phone_digits, NOT sb_phone_key. See the note above: this value is
  -- compared against contact_log.phone_norm rows written before today.
  return query select leads_out, customers_out, ph;
end;
$$;

comment on function public.contact_identity(uuid, uuid) is
  'Every lead id, customer id and the phone belonging to one person.
   Matched on sb_phone_key so that "(541) 555-0101" and "+1 541 555 0101"
   are one human; returns sb_phone_digits, which is what contact_log
   already holds.';

grant execute on function public.contact_identity(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. One implementation of "write this down and keep the record in step"
-- ---------------------------------------------------------------------------

-- record_contact() reads auth.uid() to find out who is acting. A webhook has
-- no auth.uid() — nobody is signed in, Quo is — so it cannot call it.
--
-- The tempting answer is a second function that does the same work with the
-- actor passed in. That is two copies of the rule about when a lead advances
-- and two copies of the denormalised-column update, which is exactly the
-- "second answer to the same question" this codebase keeps refusing to
-- write. So instead the body moves down one level, and record_contact
-- becomes the thin thing that supplies auth.uid().
create or replace function public.record_contact_as(
  p_actor       uuid,
  p_lead_id     uuid default null,
  p_customer_id uuid default null,
  p_kind        text default 'call',
  p_detail      text default null,
  -- The new, all optional, all defaulted so the old call shape still means
  -- exactly what it meant.
  p_direction        text    default null,
  p_outcome          text    default null,
  p_duration_seconds integer default null,
  p_provider_call_id text    default null,
  -- Did we actually reach them? Null means "this is not a call, don't ask" —
  -- which is the right answer for an email, a note, or a text.
  --
  -- THE ONE ARGUMENT THAT MATTERS. It is what decides whether a new lead
  -- moves to contacted, and separating it from p_kind is the whole point of
  -- this file: a call that rang out is still a call, and used to be
  -- indistinguishable from one where somebody answered.
  p_reached          boolean default null,
  p_at               timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  ident   record;
  lead_out uuid;
  cust_out uuid;
  new_id  bigint;
  was     text;
  becomes text;
  -- An inbound call is not outreach. It should appear on the timeline and
  -- it should not inflate the number somebody reads as "how many times have
  -- we chased this person".
  outbound boolean := coalesce(p_direction, 'out') <> 'in';
  -- Null (not a call) keeps the old behaviour: an email or a note counts as
  -- having reached out, because sending it is the whole act.
  reached  boolean := coalesce(p_reached, true);
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  lead_out := coalesce(p_lead_id, (select x from unnest(ident.lead_ids) x limit 1));
  cust_out := coalesce(p_customer_id, (select x from unnest(ident.customer_ids) x limit 1));

  -- Read the status before the update below so the move can be recorded.
  --
  -- Gated on `reached`, which is the fix. A lead only advances when
  -- somebody actually spoke to them — ringing out three times leaves them
  -- on New, which is where they belong and where the board will keep
  -- showing them until somebody gets through.
  if lead_out is not null and reached then
    select status into was from public.leads where id = lead_out;
    becomes := case when was = 'new' then 'contacted' else null end;
  end if;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, from_status, to_status, detail,
    changed_by, provider_call_id, direction, outcome, duration_seconds, created_at
  )
  values (
    lead_out, cust_out, ident.phone, coalesce(p_kind, 'call'),
    case when becomes is not null then was else null end,
    becomes, p_detail, p_actor,
    p_provider_call_id, p_direction, p_outcome, p_duration_seconds,
    -- Quo's timestamp when it gave us one. A webhook retried twenty minutes
    -- later must not put the call twenty minutes after it happened.
    coalesce(p_at, now())
  )
  -- The retry guard. Second delivery of the same call changes nothing and
  -- returns nothing, so the caller can tell a new call from a repeat.
  on conflict (provider_call_id) where provider_call_id is not null
    do nothing
  returning id into new_id;

  if new_id is null then
    return null;
  end if;

  if lead_out is not null then
    update public.leads
    set last_contacted_at = case when outbound then coalesce(p_at, now())
                                 else last_contacted_at end,
        contact_attempts  = coalesce(contact_attempts, 0)
                            + case when outbound then 1 else 0 end,
        status = case when status = 'new' and reached then 'contacted' else status end
    where id = lead_out;
  end if;

  if cust_out is not null then
    update public.customers
    set last_contacted_at = case when outbound then coalesce(p_at, now())
                                 else last_contacted_at end,
        contact_attempts  = coalesce(contact_attempts, 0)
                            + case when outbound then 1 else 0 end
    where id = cust_out;
  end if;

  return new_id;
end;
$$;

comment on function public.record_contact_as is
  'The body of record_contact(), with the actor passed in instead of read
   from auth.uid(), so a webhook can use it too. p_reached is what decides
   whether a lead advances: a call that rang out is a call, not a contact.';

-- record_contact() keeps its exact signature and its exact old meaning. The
-- only change is that the work now happens one level down.
create or replace function public.record_contact(
  p_lead_id     uuid default null,
  p_customer_id uuid default null,
  p_kind        text default 'call',
  p_detail      text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid;
begin
  select p.id into actor from public.profiles p where p.id = auth.uid();
  return public.record_contact_as(actor, p_lead_id, p_customer_id, p_kind, p_detail);
end;
$$;

grant execute on function public.record_contact(uuid, uuid, text, text) to authenticated;

-- NOT granted to authenticated. record_contact_as() can write any actor, any
-- timestamp and any outcome it likes — that is the point of it — and the
-- browser has no business doing that. It is reached by the webhook, which
-- runs as the service role, and by record_contact() above, which supplies
-- auth.uid() and cannot be talked out of it.
revoke all on function public.record_contact_as(
  uuid, uuid, uuid, text, text, text, text, integer, text, boolean, timestamptz
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. How Quo's verdict becomes a row
-- ---------------------------------------------------------------------------

-- Did this call connect?
--
-- A function rather than a condition inlined into the one place that needs
-- it, because "what counts as a call" is a policy question somebody will
-- want to change — and the next person asking it should find one answer.
--
-- Duration AND status, not either alone. Quo reports `answered` for a call
-- answered by voicemail, which lasted eleven seconds and reached nobody; and
-- a status this database has never seen before (the list has `unknown` in
-- it already) should not silently count as a conversation.
create or replace function public.sb_call_connected(
  p_status text,
  p_duration integer
)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_status, '')) in ('answered', 'forwarded')
     -- Ten seconds. Long enough to exclude a voicemail greeting cut short
     -- and a pocket dial; short enough to keep "they said they're not
     -- interested, bye".
     and coalesce(p_duration, 0) >= 10
$$;

-- Write down a call Quo has told us about.
--
-- Returns the contact_log id, or null when nothing was written — which is
-- either "we do not log this kind of call", "we do not know whose call this
-- is", or "we already have this one". The caller needs that difference for
-- its log line and nothing else; all three are ordinary and none is a fault.
create or replace function public.record_quo_call(
  p_call_id   text,
  p_phone     text,
  p_direction text,
  p_status    text,
  p_duration  integer default null,
  p_at        timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  who       record;
  status    text    := lower(coalesce(p_status, ''));
  inbound   boolean := lower(coalesce(p_direction, '')) in ('in', 'incoming', 'inbound');
  -- Somebody picked up and there was a conversation. Status AND duration —
  -- see sb_call_connected().
  connected boolean := public.sb_call_connected(p_status, p_duration);
  -- The call TOOK PLACE: it rang, or it was picked up by something. A
  -- wider net than `connected` on purpose, because a call that went to
  -- voicemail is still a call somebody made.
  happened  boolean := status in ('answered', 'forwarded',
                                  'unanswered', 'no-answer', 'noanswer', 'missed');
  kind_out  text;
  detail    text;
begin
  if coalesce(btrim(p_call_id), '') = '' then
    -- No id means no dedupe, and no dedupe means Quo's retries write the
    -- same call over and over. Refusing is better than the thing this whole
    -- file exists to stop.
    return null;
  end if;

  -- A call that did not happen is not written down. `failed` is the network
  -- refusing it, `abandoned` is whoever placed it hanging up before it rang,
  -- and `unknown` and `ai-handled` are not calls anybody had. Logging those
  -- would be the old click-to-log behaviour arriving by a different route.
  --
  -- Note what IS kept: a call that went to voicemail. Quo reports that as
  -- `answered` with a short duration, and the first draft of this gate
  -- discarded it — which would have thrown away a real call somebody really
  -- made, the exact opposite failure from the one being fixed. It rang; it
  -- counts as an attempt. What it does not count as is a conversation, and
  -- that is `connected`'s job, below.
  if not happened then
    return null;
  end if;

  select * into who from public.sb_contact_for_phone(p_phone);

  if who.lead_id is null and who.customer_id is null then
    -- A number nobody in the CRM owns: a supplier, a wrong number, Hayden's
    -- mother. Not an error and not worth a row — contact_log is a history of
    -- the people in this database, and a log of every call to anybody is a
    -- different feature that nobody asked for.
    return null;
  end if;

  -- Four kinds, because direction and outcome are two separate facts and
  -- the timeline has to show both. "Called" on a row where the customer
  -- rang US reads as something Sky Blue did, which is the opposite of what
  -- happened and the opposite of what you want to know before picking the
  -- phone up.
  kind_out := case
                when connected and inbound then 'call_in'
                when connected             then 'call'
                when inbound               then 'call_missed'
                else                            'call_attempt'
              end;

  detail := case
              when connected
                then (coalesce(p_duration, 0) / 60)::text || 'm '
                     || (coalesce(p_duration, 0) % 60)::text || 's'
              -- Picked up by a machine. Quo says `answered`; it was not.
              -- Worth distinguishing from a phone that simply rang out,
              -- because leaving a message and getting no answer at all are
              -- different things to have done.
              when status in ('answered', 'forwarded') and inbound
                then 'Went to our voicemail'
              when status in ('answered', 'forwarded')
                then 'Voicemail'
              when inbound then 'They rang, we missed it'
              else 'No answer'
            end;

  -- THE IDS ARE PASSED DOWN, and this is the line to get wrong.
  --
  -- record_contact_as() resolves a person through contact_identity(), which
  -- needs an id to start from and finds nothing at all when given two
  -- nulls. A webhook has no id — it has a phone number — so the lookup has
  -- to happen HERE, above, and its answer has to be handed on. The first
  -- draft of this function called sb_contact_for_phone(), checked the
  -- result, and then passed nulls anyway: every call would have been logged
  -- against nobody, which is the exact orphaning bug
  -- db/sms-app-messages.sql was written to fix, reintroduced one file later.
  return public.record_contact_as(
    null,            -- Quo placed it; no profile in this database did.
    who.lead_id,
    who.customer_id,
    kind_out,
    detail,
    case when inbound then 'in' else 'out' end,
    status,
    p_duration,
    p_call_id,
    connected,
    p_at
  );
exception
  when others then
    -- Never throws. The caller is a webhook that must answer 200 or Quo
    -- retries, and losing one line of history is a far smaller loss than a
    -- retry storm.
    raise warning 'record_quo_call failed for % : %', p_call_id, sqlerrm;
    return null;
end;
$$;

comment on function public.record_quo_call(text, text, text, text, integer, timestamptz) is
  'One call.completed event from Quo, as a row on the right person history —
   but only when Quo says the call actually happened.';
