-- Sky Blue CRM — text messages
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Texts go out through Twilio on the CRM's own number. Google Voice stays
-- exactly as it is for calls and for texting by hand — it has no API at any
-- price, and driving its web interface with a script is a violation of the
-- Workspace terms that would take the whole Google account with it.
--
-- Four automatic sends:
--   * the quote itself, when there is no email on file
--   * a nudge on a quote that was never opened
--   * a nudge on a quote that WAS opened and not accepted
--   * a reminder the afternoon before a scheduled visit
--
-- THE SAME RULE AS db/follow-ups.sql APPLIES, and more sharply. An email
-- sent twice is an annoyance. A text sent twice is an annoyance that costs
-- money, arrives on a lock screen, and is the single fastest way to make a
-- customer reply STOP — which is permanent and legally binding. So the
-- safety lives here, not in the sending code:
--
--   * one text per (quote, kind) and one per job, enforced by a unique index
--   * rows are CLAIMED before sending, so two overlapping runs can't both
--     pick up the same one
--   * an opt-out is checked at SEND time and cannot be overridden by any
--     caller, including a person pressing a button
--   * quiet hours are enforced in the database, not the scheduler
--   * anything older than the window is never sent, so a function that was
--     broken for a fortnight can't come back up and text everybody

-- ---------------------------------------------------------------------------
-- 0. The knobs
-- ---------------------------------------------------------------------------

-- Functions rather than a settings table, matching db/follow-ups.sql: they
-- inline into the queries below and there is no row to forget to seed.

-- Earliest and latest hour, local, at which the CRM will send. The TCPA
-- floor is 8am–9pm; this is deliberately tighter, because the legal
-- minimum and the hour at which a text from a window cleaner is welcome are
-- not the same number.
--
-- Read as: send allowed while the local hour is >= open and < close. With
-- 9 and 20 that is 9:00am through 7:59pm.
create or replace function public.sb_sms_open_hour()
returns int language sql immutable as $$ select 9 $$;

create or replace function public.sb_sms_close_hour()
returns int language sql immutable as $$ select 20 $$;

-- A quote that was delivered and never opened. Three days: long enough that
-- it isn't nagging, short enough that the job hasn't gone to someone else.
create or replace function public.sb_sms_nudge_unopened_days()
returns int language sql immutable as $$ select 3 $$;

-- A quote they DID open and didn't accept. Shorter, because this one is
-- warm — they were interested enough to look.
create or replace function public.sb_sms_nudge_opened_days()
returns int language sql immutable as $$ select 2 $$;

-- The blast guard. Nothing older than this is ever chased, however long the
-- scheduler was down. Mirrors sb_follow_up_window_days().
create or replace function public.sb_sms_window_days()
returns int language sql immutable as $$ select 14 $$;

-- How long a claimed-but-unsent row may sit before the sweep gives up on it
-- and frees the slot for a retry. Longer than any plausible Twilio call.
create or replace function public.sb_sms_stale_minutes()
returns int language sql immutable as $$ select 15 $$;

-- Oregon, not UTC. Redeclared here (it also lives in db/job-events.sql and
-- db/follow-ups.sql) so this file stands on its own whichever order they are
-- run in.
create or replace function public.sb_local(ts timestamptz)
returns timestamp language sql immutable
as $$ select ts at time zone 'America/Los_Angeles' $$;

-- ---------------------------------------------------------------------------
-- 1. Phone numbers
-- ---------------------------------------------------------------------------

-- sb_phone_digits() already exists in db/contact-history.sql and is what
-- contact_log and the timeline match on. Redeclared identically here so this
-- file can be run first; the two definitions must stay byte-identical or a
-- text logged by one will not be found by the other.
create or replace function public.sb_phone_digits(p text)
returns text
language sql
immutable
as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

-- What Twilio needs on the wire: +1 and ten digits.
--
-- Null for anything that isn't a plausible US number, and that null is load
-- bearing — it is what stops the CRM handing Twilio a half-typed number and
-- paying for the rejection. Numbers in this CRM are typed by hand on a
-- driveway, so "541-730-359" happens.
create or replace function public.sb_sms_e164(p text)
returns text
language sql
immutable
as $$
  select case
    when public.sb_phone_digits(p) ~ '^[2-9][0-9]{9}$'
      then '+1' || public.sb_phone_digits(p)
    when public.sb_phone_digits(p) ~ '^1[2-9][0-9]{9}$'
      then '+' || public.sb_phone_digits(p)
    else null
  end
$$;

comment on function public.sb_sms_e164(text) is
  'A US number as +1XXXXXXXXXX, or null if it could not possibly be one.
   Rejects a leading 0 or 1 in the area code, which no US area code has.';

-- ---------------------------------------------------------------------------
-- 2. Who has said stop
-- ---------------------------------------------------------------------------

-- Keyed on the PHONE, not on a customer or lead id, and that is the whole
-- point. The same number is often a lead and a customer, sometimes several
-- of each — contact_identity() exists precisely because one human scatters
-- across rows. An opt-out attached to a row would be escaped the moment a
-- second lead was knocked at the same house.
--
-- Carriers treat STOP as binding on the number. So does this table.
create table if not exists public.sms_opt_outs (
  phone        text primary key,
  opted_out_at timestamptz not null default now(),
  -- stop | manual. 'stop' came from the customer's own handset and is the
  -- one with legal weight; 'manual' is someone in the office being asked
  -- nicely in person.
  source       text not null default 'stop',
  -- The message they actually sent, kept verbatim. If there is ever an
  -- argument about whether someone opted out, this is the evidence.
  last_message text
);

comment on table public.sms_opt_outs is
  'Numbers that must not be texted. Presence of a row is the opt-out;
   START deletes it. Checked inside claim_sms(), which no caller can skip.';

alter table public.sms_opt_outs enable row level security;

drop policy if exists "sms_opt_outs readable by authenticated" on public.sms_opt_outs;
create policy "sms_opt_outs readable by authenticated"
  on public.sms_opt_outs for select to authenticated using (true);

-- No insert or update policy. Writes go through the security-definer
-- functions below, so there is one code path that can un-opt-out a number.

-- ---------------------------------------------------------------------------
-- 3. The outbox
-- ---------------------------------------------------------------------------

create table if not exists public.sms_messages (
  id          bigint generated always as identity primary key,

  direction   text not null default 'out'
              check (direction in ('out', 'in')),

  -- The CUSTOMER's number in both directions — the recipient on the way
  -- out, the sender on the way in. Sky Blue's own number is the same on
  -- every row and lives in an environment variable, not here.
  phone       text not null,

  body        text not null,

  -- quote | nudge_sent | nudge_viewed | reminder | manual | inbound
  -- Text, not an enum, so a new kind of message is app-side only — the same
  -- reasoning as lead_events.kind and contact_log.kind.
  kind        text not null default 'manual',

  -- All nullable, all stamped when known. on delete set null rather than
  -- cascade, deliberately: deleting a lead must not erase the record that
  -- this number was texted, or that they replied STOP.
  lead_id     uuid references public.leads (id)     on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  quote_id    uuid references public.quotes (id)    on delete set null,
  job_id      uuid references public.jobs (id)      on delete set null,

  -- queued    — claimed by a run that is mid-flight
  -- sent      — Twilio accepted it
  -- failed    — Twilio rejected it, or the run died; the slot is freed
  -- received  — inbound
  status      text not null default 'queued'
              check (status in ('queued', 'sent', 'failed', 'received')),

  provider_sid text,
  error        text,
  sent_by      uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,

  -- THE DOUBLE-SEND GUARD, and the most important lines in this file.
  --
  -- A generated column rather than a rule in the sending code, because the
  -- sending code is what will be wrong. Null for anything hand-written: a
  -- person typing a second text to the same customer is not a bug.
  dedupe_key  text generated always as (
    case
      when quote_id is not null
       and kind in ('quote', 'nudge_sent', 'nudge_viewed')
        then kind || ':q:' || quote_id::text
      when job_id is not null and kind = 'reminder'
        then 'reminder:j:' || job_id::text
      else null
    end
  ) stored
);

-- Unique only over rows that went out or are going out. A 'failed' row
-- leaves the index, which is what makes a retry possible after a Twilio
-- outage without ever allowing a second delivery of one that succeeded.
create unique index if not exists sms_messages_dedupe_idx
  on public.sms_messages (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'sent');

create index if not exists sms_messages_lead_idx
  on public.sms_messages (lead_id, created_at);
create index if not exists sms_messages_customer_idx
  on public.sms_messages (customer_id, created_at);
create index if not exists sms_messages_phone_idx
  on public.sms_messages (phone, created_at);
-- For the sweep.
create index if not exists sms_messages_queued_idx
  on public.sms_messages (created_at) where status = 'queued';

comment on table public.sms_messages is
  'Every text in and out, and the state machine for sending one. The
   successful ones are ALSO written to contact_log so they appear on the
   contact timeline — this table is the outbox, that one is the history.';

alter table public.sms_messages enable row level security;

drop policy if exists "sms_messages readable by authenticated" on public.sms_messages;
create policy "sms_messages readable by authenticated"
  on public.sms_messages for select to authenticated using (true);

-- No insert or update policy, same as follow_ups: everything is written by
-- the security-definer functions below, so there is exactly one code path
-- that can mark something sent.

-- ---------------------------------------------------------------------------
-- 4. The guards
-- ---------------------------------------------------------------------------

create or replace function public.sb_sms_opted_out(p_phone text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.sms_opt_outs o
     where o.phone = public.sb_sms_e164(p_phone)
  )
$$;

-- Is it too early or too late to text somebody right now?
--
-- Enforced in the database rather than by scheduling the function at a
-- civilised hour, because a retry, a manual run, or a daylight-saving shift
-- all move when the code actually executes. The rule should hold whenever
-- it runs, not because of when it was meant to.
create or replace function public.sb_sms_quiet_now()
returns boolean
language sql
stable
as $$
  select extract(hour from public.sb_local(now()))::int
           not between public.sb_sms_open_hour()
                   and public.sb_sms_close_hour() - 1
$$;

comment on function public.sb_sms_quiet_now() is
  'True when an automatic text must not go out. Local Oregon time, so it
   follows daylight saving without anyone editing a cron expression.';

-- ---------------------------------------------------------------------------
-- 5. Claiming one to send
-- ---------------------------------------------------------------------------

-- Returns a row id to send, or a reason why not. Never raises: the caller is
-- a scheduled function working through a list, and one unsendable number
-- must not abandon the rest of the batch.
--
-- p_force is for a person pressing a button. It skips the quiet hours —
-- somebody replying to a customer at 8:30pm is answering, not marketing —
-- and it skips the "is this a duplicate" question only insofar as a manual
-- message has no dedupe key to begin with.
--
-- p_force DOES NOT skip the opt-out. That check has no override anywhere in
-- this file, on purpose. A STOP is the customer's instruction and the
-- carriers' rule, and the office being sure it's fine is exactly the
-- situation the rule exists for.
-- Dropped first, not just replaced: `create or replace` refuses to change a
-- function's return type, and this one gained the normalised phone after the
-- first version shipped.
drop function if exists public.claim_sms(text, text, text, uuid, uuid, uuid, uuid, uuid, boolean);

create or replace function public.claim_sms(
  p_kind        text,
  p_phone       text,
  p_body        text,
  p_lead_id     uuid    default null,
  p_customer_id uuid    default null,
  p_quote_id    uuid    default null,
  p_job_id      uuid    default null,
  p_sent_by     uuid    default null,
  p_force       boolean default false
)
-- `phone` comes back normalised so the caller sends to exactly the number
-- that was recorded. Deriving it twice — once here, once in JavaScript — is
-- how a row and a message end up disagreeing about who was texted.
returns table (id bigint, ok boolean, reason text, phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
  e164   text;
  new_id bigint;
begin
  e164 := public.sb_sms_e164(p_phone);

  if e164 is null then
    return query select null::bigint, false, 'bad_number', null::text;
    return;
  end if;

  if coalesce(btrim(p_body), '') = '' then
    return query select null::bigint, false, 'empty_body', e164;
    return;
  end if;

  -- No override. See the note above.
  if public.sb_sms_opted_out(e164) then
    return query select null::bigint, false, 'opted_out', e164;
    return;
  end if;

  if not p_force and public.sb_sms_quiet_now() then
    return query select null::bigint, false, 'quiet_hours', e164;
    return;
  end if;

  -- The insert IS the claim. Two runs racing on the same quote both reach
  -- this line; the unique index lets exactly one through and the other gets
  -- no row back.
  insert into public.sms_messages (
    direction, phone, body, kind,
    lead_id, customer_id, quote_id, job_id,
    status, sent_by
  )
  values (
    'out', e164, p_body, coalesce(p_kind, 'manual'),
    p_lead_id, p_customer_id, p_quote_id, p_job_id,
    'queued', p_sent_by
  )
  on conflict (dedupe_key)
    where dedupe_key is not null and status in ('queued', 'sent')
    do nothing
  returning sms_messages.id into new_id;

  if new_id is null then
    return query select null::bigint, false, 'already_sent', e164;
    return;
  end if;

  return query select new_id, true, 'claimed'::text, e164;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Marking the outcome
-- ---------------------------------------------------------------------------

-- Also writes the contact_log row, so a text shows up on the contact
-- timeline beside the calls and the job milestones.
--
-- Written here rather than by the sender for the same reason the claim is:
-- the two writes belong in one transaction. A text that was delivered but
-- missing from the history is how somebody ends up sending it again by hand.
create or replace function public.mark_sms_sent(
  p_id  bigint,
  p_sid text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.sms_messages;
begin
  update public.sms_messages
     set status = 'sent', sent_at = now(), provider_sid = p_sid, error = null
   where sms_messages.id = p_id and status = 'queued'
  returning * into m;

  if m.id is null then
    return;   -- already marked, or swept; nothing to do and nothing wrong
  end if;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, changed_by, created_at
  )
  values (
    m.lead_id, m.customer_id, public.sb_phone_digits(m.phone),
    'text', m.body, m.sent_by, now()
  );

  -- Keep the denormalised "last reached out" columns in step, the way
  -- record_contact() does. Deliberately NOT advancing a lead from new to
  -- contacted: these are automatic, and a lead nobody has actually spoken
  -- to should not quietly move down the funnel because a robot texted it.
  if m.lead_id is not null then
    update public.leads
       set last_contacted_at = now(),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = m.lead_id;
  end if;

  if m.customer_id is not null then
    update public.customers
       set last_contacted_at = now(),
           contact_attempts  = coalesce(contact_attempts, 0) + 1
     where id = m.customer_id;
  end if;
end;
$$;

create or replace function public.mark_sms_failed(
  p_id    bigint,
  p_error text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.sms_messages
     set status = 'failed', error = p_error
   where id = p_id and status = 'queued'
$$;

-- Frees rows claimed by a run that died before it could mark them. Without
-- this a crashed send would hold the dedupe slot forever and that quote
-- would never be chased again.
--
-- Returns the number released, so the run can log it.
create or replace function public.sweep_sms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with released as (
    update public.sms_messages
       set status = 'failed',
           error  = coalesce(error, 'abandoned by a run that did not finish')
     where status = 'queued'
       and created_at < now()
                        - (public.sb_sms_stale_minutes() || ' minutes')::interval
    returning 1
  )
  select count(*)::int into n from released;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Inbound
-- ---------------------------------------------------------------------------

create or replace function public.record_sms_opt_out(
  p_phone text,
  p_body  text default null,
  p_source text default 'stop'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e164 text := public.sb_sms_e164(p_phone);
begin
  if e164 is null then return; end if;

  insert into public.sms_opt_outs (phone, source, last_message)
  values (e164, coalesce(p_source, 'stop'), p_body)
  on conflict (phone) do update
    set opted_out_at = now(),
        source       = excluded.source,
        last_message = coalesce(excluded.last_message, sms_opt_outs.last_message);
end;
$$;

-- START / UNSTOP. Only ever in response to the customer's own message —
-- there is no button in the CRM for this, and there shouldn't be.
create or replace function public.record_sms_opt_in(p_phone text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.sms_opt_outs
   where phone = public.sb_sms_e164(p_phone)
$$;

-- A text FROM a customer. Attaches it to whoever that number belongs to and
-- puts it on the timeline.
--
-- Does NOT use record_contact(): that function reads auth.uid() (there is no
-- session on a Twilio webhook), counts a contact ATTEMPT, and advances a new
-- lead to contacted. All three are wrong for a message we received.
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
  e164     text := public.sb_sms_e164(p_phone);
  digits   text := public.sb_phone_digits(p_phone);
  lead_out uuid;
  cust_out uuid;
  new_id   bigint;
begin
  if e164 is null then
    return null;
  end if;

  -- Most recent match wins. Someone who has been a lead twice and a
  -- customer once should have their reply land on the record being worked
  -- today, not the one from March.
  select c.id into cust_out
    from public.customers c
   where public.sb_phone_digits(c.phone) = digits
   order by c.created_at desc
   limit 1;

  select l.id into lead_out
    from public.leads l
   where public.sb_phone_digits(l.phone) = digits
   order by l.created_at desc
   limit 1;

  insert into public.sms_messages (
    direction, phone, body, kind, lead_id, customer_id, status, provider_sid, sent_at
  )
  values (
    'in', e164, p_body, 'inbound', lead_out, cust_out, 'received', p_sid, now()
  )
  returning sms_messages.id into new_id;

  -- 'text_in', not 'text'. The timeline renders direction from the kind, and
  -- a reply shown as outreach would make the contact history read as though
  -- Sky Blue said something it never said.
  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (lead_out, cust_out, digits, 'text_in', p_body, now());

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. What is due
-- ---------------------------------------------------------------------------

-- Quotes worth chasing, with everything the message needs.
--
-- Expiry is computed, never stored — the same decision quoteService.js makes
-- on the client, so the two always agree about what "expired" means.
create or replace function public.sms_due_quote_nudges(p_limit int default 25)
returns table (
  quote_id      uuid,
  lead_id       uuid,
  customer_id   uuid,
  token         text,
  amount        numeric,
  customer_name text,
  phone         text,
  kind          text
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
         case when q.status = 'viewed' then 'nudge_viewed' else 'nudge_sent' end
  from public.quotes q
  left join public.leads     l on l.id = q.lead_id
  left join public.customers c on c.id = q.customer_id
  where q.status in ('sent', 'viewed')
    -- Still live. There is no point chasing a quote the customer can no
    -- longer accept.
    and q.expires_at > now()
    -- The blast guard.
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
    and not exists (
      select 1 from public.sms_messages m
       where m.quote_id = q.id
         and m.status in ('queued', 'sent')
         and m.kind = case when q.status = 'viewed'
                           then 'nudge_viewed' else 'nudge_sent' end
    )
  order by coalesce(q.viewed_at, q.sent_at, q.created_at)
  limit p_limit
$$;

-- Jobs happening tomorrow.
--
-- Tomorrow by LOCAL DATE, not "within 24 hours". A job at 8am Tuesday and
-- one at 4pm Tuesday should both be reminded on Monday afternoon; an
-- interval from now() would catch one and miss the other.
create or replace function public.sms_due_job_reminders(p_limit int default 50)
returns table (
  job_id        uuid,
  lead_id       uuid,
  customer_id   uuid,
  customer_name text,
  phone         text,
  starts_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select j.id,
         j.lead_id,
         j.customer_id,
         coalesce(c.name, l.name),
         coalesce(c.phone, l.phone),
         j.starts_at
  from public.jobs j
  left join public.customers c on c.id = j.customer_id
  left join public.leads     l on l.id = j.lead_id
  -- 'scheduled' only. An 'upcoming' job is a recurring visit the plan says
  -- is due; nobody has agreed a day, so there is nothing to remind anyone
  -- about and a text would invent an appointment.
  where j.status = 'scheduled'
    and j.starts_at is not null
    and public.sb_local(j.starts_at)::date
          = public.sb_local(now())::date + 1
    and public.sb_sms_e164(coalesce(c.phone, l.phone)) is not null
    and not public.sb_sms_opted_out(coalesce(c.phone, l.phone))
    and not exists (
      select 1 from public.sms_messages m
       where m.job_id = j.id
         and m.kind = 'reminder'
         and m.status in ('queued', 'sent')
    )
  order by j.starts_at
  limit p_limit
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

-- The sending functions are service_role only. Nothing signed in as a user
-- should be able to mark a text sent, and the CRM never sends one directly
-- — it asks a Netlify function, which is also what keeps the Twilio
-- credentials off the client.
grant execute on function public.claim_sms(text, text, text, uuid, uuid, uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.mark_sms_sent(bigint, text)        to service_role;
grant execute on function public.mark_sms_failed(bigint, text)      to service_role;
grant execute on function public.sweep_sms()                        to service_role;
grant execute on function public.record_sms_opt_out(text, text, text) to service_role;
grant execute on function public.record_sms_opt_in(text)            to service_role;
grant execute on function public.record_inbound_sms(text, text, text) to service_role;
grant execute on function public.sms_due_quote_nudges(int)          to service_role;
grant execute on function public.sms_due_job_reminders(int)         to service_role;

-- Readable by the app, so the CRM can show "texts are off for this number"
-- and preview what the nightly run would do.
grant execute on function public.sb_sms_e164(text)      to authenticated;
grant execute on function public.sb_sms_opted_out(text) to authenticated;
grant execute on function public.sb_sms_quiet_now()     to authenticated;
grant execute on function public.sms_due_quote_nudges(int)  to authenticated;
grant execute on function public.sms_due_job_reminders(int) to authenticated;
