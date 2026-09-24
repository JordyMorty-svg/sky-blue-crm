-- ===========================================================================
-- Knowing when an EMAIL did not arrive
-- ===========================================================================
--
-- Run after db/sms-delivery.sql. Safe to run twice.
--
-- The gap this closes
-- -------------------
-- db/sms-delivery.sql fixed exactly half the problem. A text that a carrier
-- refuses is now recorded, surfaced, and stops being retried. An email is
-- still sent into the dark: the CRM posts it to Resend, gets a 200 with an
-- id, and never asks again. If the address is dead, or the customer marked
-- us as spam, or their server refused it, nothing anywhere says so.
--
-- That matters more now than it did, because sms-delivery.sql made email the
-- FALLBACK. A quote whose text is refused is emailed instead — so the one
-- path we rely on when the first path fails is the path with no delivery
-- checking at all. Two silent failures in a row and a customer who is simply
-- never contacted.
--
-- Why a separate table and not sms_messages
-- -----------------------------------------
-- They look similar enough to merge and should not be. sms_messages is built
-- around an E.164 phone number: the dedupe key, the opt-out list, the
-- unreachable list and sb_sms_e164() all assume one. An email address is a
-- different kind of thing with a different failure vocabulary — a bounce is
-- not an "undelivered", a spam complaint has no SMS equivalent at all, and a
-- provider id from Resend is not a Quo message id.
--
-- Merging them would mean a table where half the columns are null in half
-- the rows, and a status check listing seven words where any given row can
-- only use four of them. They are joined at the top instead, in the
-- delivery_failures view, which is the only place anything actually wants to
-- see them together.
--
-- What is needed on Jordan's side
-- -------------------------------
-- Nothing here starts working on its own. Resend has to be told where to
-- send delivery events: Resend dashboard -> Webhooks -> Add endpoint,
--
--     https://crm.skybluecleaningco.com/.netlify/functions/email-events
--
-- with email.bounced, email.complained and email.delivered ticked, and the
-- signing secret pasted into Netlify as RESEND_WEBHOOK_SECRET.
--
-- Until that exists, every email is still recorded as sent — which is worth
-- having on its own, because "was this customer ever actually emailed" has
-- no answer today — but nothing will ever be marked bounced.

-- NOTE: no `\set ON_ERROR_STOP on` here, deliberately.
--
-- That is a psql meta-command, not SQL. The Supabase SQL editor sends what
-- you paste straight to Postgres, which answers
--
--     ERROR: 42601: syntax error at or near "\"
--
-- on the very first line and runs nothing. Every other file in db/ is plain
-- SQL for exactly this reason; the flag belongs in verify/*.sql, which are
-- run through psql.


-- ---------------------------------------------------------------------------
-- 1. Every email that went out
-- ---------------------------------------------------------------------------

create table if not exists public.sent_emails (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  -- Which message this was: quote, quote_fallback, reminder, follow_up,
  -- review, receipt. Free text rather than an enum, because the set grows
  -- every time a new kind of email is added and a migration to add one word
  -- to an enum is a migration nobody writes — they reuse 'follow_up' for
  -- something that isn't one instead.
  kind         text not null,

  to_email     text not null,

  -- The subject, not the body. The body is a 4KB HTML template that is
  -- identical across every quote ever sent; storing it per row buys nothing
  -- and makes the failures list slow to read. The subject is what a person
  -- scanning the list actually needs to recognise the message.
  subject      text,

  -- sent       — Resend accepted it. Says nothing about arrival.
  -- delivered  — the receiving server accepted it. The good ending.
  -- bounced    — it was refused. Permanent or not; sb_email_permanent() says.
  -- complained — they marked it as spam. Never email them again.
  -- failed     — it never reached Resend at all. Safe to send again.
  status       text not null default 'sent'
    check (status in ('sent', 'delivered', 'bounced', 'complained', 'failed')),

  error        text,

  -- Resend's own id. The handle that ties a webhook event back to this row,
  -- and the thing Resend support asks for.
  provider_id  text,

  lead_id      uuid references public.leads (id)      on delete set null,
  customer_id  uuid references public.customers (id)  on delete set null,
  quote_id     uuid references public.quotes (id)     on delete set null,
  job_id       uuid references public.jobs (id)       on delete set null,
  sent_by      uuid references public.profiles (id)   on delete set null,

  updated_at   timestamptz
);

-- Unique only where there IS a provider id. A send that failed before Resend
-- answered has no id and there can be many of those; two rows claiming the
-- same Resend id is a bug.
--
-- The predicate is repeated verbatim in the ON CONFLICT clauses below.
-- Postgres matches a partial index by its predicate, and a conflict target
-- that does not state the same one is not matched at all — it raises "no
-- unique or exclusion constraint matching", which at least fails loudly.
drop index if exists public.sent_emails_provider_idx;
create unique index sent_emails_provider_idx
  on public.sent_emails (provider_id)
  where provider_id is not null;

create index if not exists sent_emails_recent_idx
  on public.sent_emails (created_at desc);

create index if not exists sent_emails_quote_idx
  on public.sent_emails (quote_id) where quote_id is not null;

create index if not exists sent_emails_job_idx
  on public.sent_emails (job_id) where job_id is not null;

comment on table public.sent_emails is
  'Every email the CRM has sent, and what became of it. Written by the send
   helpers, updated by the Resend webhook.';

alter table public.sent_emails enable row level security;

-- Read-only to staff. Every write comes from a Netlify function holding the
-- service role, which bypasses RLS — so there is deliberately no insert or
-- update policy here. A browser cannot invent a sent email.
drop policy if exists sent_emails_staff_read on public.sent_emails;
create policy sent_emails_staff_read
  on public.sent_emails for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. Addresses that are closed
-- ---------------------------------------------------------------------------
--
-- The same shape as sms_unreachable, for the same reason. Without it the
-- nightly follow-up run emails a dead address every single night, and the
-- failures list fills with forty copies of one problem until the one real
-- one underneath is invisible.

create table if not exists public.email_unreachable (
  email        text primary key,

  -- Kept verbatim. "mailbox does not exist" and "spam complaint" both stop
  -- us sending, and they are not the same thing to whoever reads this later
  -- deciding whether to phone them.
  reason       text,

  -- Set for a spam complaint. That is a stronger fact than a bounce: a bounce
  -- may be a full mailbox, a complaint is a person saying stop. Shown
  -- differently in the CRM, and never cleared casually.
  complained   boolean not null default false,

  failures     int not null default 1,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),

  cleared_at   timestamptz,
  cleared_by   uuid references public.profiles (id) on delete set null
);

comment on table public.email_unreachable is
  'Addresses that bounced permanently or reported us as spam. Checked before
   every automatic email.';

alter table public.email_unreachable enable row level security;

drop policy if exists email_unreachable_staff_read on public.email_unreachable;
create policy email_unreachable_staff_read
  on public.email_unreachable for select to authenticated using (true);

drop policy if exists email_unreachable_staff_update on public.email_unreachable;
create policy email_unreachable_staff_update
  on public.email_unreachable for update to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Reading a bounce
-- ---------------------------------------------------------------------------

-- Lowercased and trimmed, nothing cleverer. Email addresses are
-- case-insensitive in the domain and, in practice, in the mailbox too for
-- every provider a window cleaning customer uses. Normalising is what makes
-- the primary key above do its job — Judy@ and judy@ must be one row.
create or replace function public.sb_email_norm(p_email text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(btrim(coalesce(p_email, ''))), '')
$$;

-- Is this refusal about the ADDRESS, or about this attempt?
--
-- The same distinction as sb_sms_permanent(), and the same care: only
-- destination-related wording counts. A full mailbox, a greylisting, a
-- temporary deferral and "try again later" are all about right now, and
-- suppressing an address over one of those loses a real customer quietly.
--
-- A spam complaint is handled by the caller rather than matched here — it
-- arrives as an event type, not as an error string.
create or replace function public.sb_email_permanent(p_reason text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_reason, '') ~* (
    'permanent'
    '|hard ?bounce'
    '|suppress'
    '|invalid (recipient|address|mailbox)'
    '|(mailbox|recipient|user|address|domain).{0,20}(not found|does not exist|unknown|rejected)'
    '|no such (user|mailbox|recipient)'
    '|unrouteable|unroutable'
    -- The SMTP permanent-failure code, and only where it is unmistakably
    -- one: at the very start of the reason, or followed by an enhanced
    -- status code ("550 5.1.1 ...").
    --
    -- A word boundary is not enough. Mail servers quote the rejected message
    -- back at you, and this business sends quotes with prices in them — so
    -- "Rejected: Your quote for $550" would suppress a real customer over
    -- the amount they were quoted. That is a silent, permanent loss of a
    -- paying customer caused by a three-character pattern, which is exactly
    -- the kind of thing nobody would ever find.
    '|^550\M'
    '|550 5\.[0-9]'
  )
$$;

create or replace function public.sb_email_unreachable(p_email text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.email_unreachable u
     where u.email = public.sb_email_norm(p_email)
       and u.cleared_at is null
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. Writing one down
-- ---------------------------------------------------------------------------

-- Called by the send helpers the moment Resend answers.
--
-- Returns the row id so a caller can tie a later event to it, and does
-- nothing on a duplicate provider id — a Netlify function that is retried
-- after it already sent must not produce a second record of one email.
create or replace function public.record_email_sent(
  p_kind        text,
  p_to          text,
  p_subject     text default null,
  p_provider_id text default null,
  p_status      text default 'sent',
  p_error       text default null,
  p_lead_id     uuid default null,
  p_customer_id uuid default null,
  p_quote_id    uuid default null,
  p_job_id      uuid default null,
  p_sent_by     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if public.sb_email_norm(p_to) is null then
    return null;
  end if;

  insert into public.sent_emails (
    kind, to_email, subject, provider_id, status, error,
    lead_id, customer_id, quote_id, job_id, sent_by
  )
  values (
    coalesce(nullif(btrim(p_kind), ''), 'unknown'),
    public.sb_email_norm(p_to),
    p_subject,
    nullif(btrim(coalesce(p_provider_id, '')), ''),
    coalesce(p_status, 'sent'),
    p_error,
    p_lead_id, p_customer_id, p_quote_id, p_job_id, p_sent_by
  )
  on conflict (provider_id) where provider_id is not null
  do nothing
  returning id into v_id;

  -- DO NOTHING returns no row, so a duplicate leaves v_id null. Hand back
  -- the existing row's id rather than null: the caller asked "which record
  -- is this email", and "there isn't one" would be a lie.
  if v_id is null and nullif(btrim(coalesce(p_provider_id, '')), '') is not null then
    select id into v_id
      from public.sent_emails
     where provider_id = btrim(p_provider_id);
  end if;

  return v_id;
end;
$$;

-- Called by the Resend webhook.
--
-- Returns a row the FIRST time a given event is recorded and nothing on a
-- repeat, exactly like mark_sms_undelivered(). Resend retries webhooks, and
-- the caller uses the returned row to decide whether to do something about
-- it — telling the office twice about one bounce is how a notification
-- becomes noise that gets muted.
drop function if exists public.mark_email_failed(text, text, text, text);

create function public.mark_email_failed(
  p_provider_id text,
  p_to          text,
  p_status      text,
  p_error       text default null
)
returns table (
  out_id          uuid,
  out_email       text,
  out_kind        text,
  out_lead_id     uuid,
  out_customer_id uuid,
  out_quote_id    uuid,
  out_job_id      uuid,
  out_permanent   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       public.sent_emails%rowtype;
  v_to        text := public.sb_email_norm(p_to);
  v_status    text := coalesce(nullif(btrim(p_status), ''), 'bounced');
  v_permanent boolean;
begin
  if v_status not in ('bounced', 'complained', 'failed') then
    return;
  end if;

  -- A complaint is permanent by definition. Nobody marks a business as spam
  -- and wants the next email. Otherwise the wording decides.
  v_permanent := (v_status = 'complained') or public.sb_email_permanent(p_error);

  if nullif(btrim(coalesce(p_provider_id, '')), '') is not null then
    select * into v_row
      from public.sent_emails
     where provider_id = btrim(p_provider_id)
     for update;
  end if;

  if v_row.id is null then
    -- An event for an email this table has never seen: sent before this
    -- migration existed, or sent by something other than the CRM.
    --
    -- Recorded anyway rather than dropped. The entire point of this file is
    -- that a customer who was never reached should be visible, and "we have
    -- no record of sending it" is not a reason to also have no record of it
    -- failing. Marked 'unknown' so the list says plainly what it is.
    if v_to is null then
      return;
    end if;

    insert into public.sent_emails (
      kind, to_email, subject, provider_id, status, error, updated_at
    )
    values (
      'unknown', v_to, null,
      nullif(btrim(coalesce(p_provider_id, '')), ''),
      v_status, p_error, now()
    )
    on conflict (provider_id) where provider_id is not null
    do nothing
    returning * into v_row;

    -- Lost the race with another delivery of the same webhook. The other one
    -- is reporting it; this one says nothing.
    if v_row.id is null then
      return;
    end if;
  else
    -- Already in a terminal state. This is the retry, not the event.
    if v_row.status in ('bounced', 'complained', 'failed') then
      return;
    end if;

    update public.sent_emails
       set status     = v_status,
           error      = coalesce(p_error, error),
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
  end if;

  if v_permanent then
    insert into public.email_unreachable (email, reason, complained)
    values (
      coalesce(v_to, v_row.to_email),
      coalesce(p_error, v_status),
      v_status = 'complained'
    )
    on conflict (email) do update
      set reason     = coalesce(excluded.reason, public.email_unreachable.reason),
          complained = public.email_unreachable.complained or excluded.complained,
          failures   = public.email_unreachable.failures + 1,
          last_at    = now(),
          -- Reopened by hand and then refused again: close it. Otherwise a
          -- cleared row would stay cleared forever and the address would be
          -- emailed every night.
          cleared_at = null,
          cleared_by = null;
  end if;

  out_id          := v_row.id;
  out_email       := v_row.to_email;
  out_kind        := v_row.kind;
  out_lead_id     := v_row.lead_id;
  out_customer_id := v_row.customer_id;
  out_quote_id    := v_row.quote_id;
  out_job_id      := v_row.job_id;
  out_permanent   := v_permanent;
  return next;
end;
$$;

-- Marking one delivered. Not a failure, but the row should stop saying
-- "sent" once we know better, and "was it ever actually delivered" is the
-- question that started all of this.
create or replace function public.mark_email_delivered(p_provider_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sent_emails
     set status = 'delivered', updated_at = now()
   where provider_id = nullif(btrim(coalesce(p_provider_id, '')), '')
     and status = 'sent'
  returning true
$$;

-- Let an address back in. Through a function rather than an UPDATE so who
-- did it is recorded, same as clear_sms_unreachable().
create or replace function public.clear_email_unreachable(
  p_email text,
  p_by    uuid default auth.uid()
)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.email_unreachable
     set cleared_at = now(), cleared_by = p_by
   where email = public.sb_email_norm(p_email)
     and cleared_at is null
  returning true
$$;

-- ---------------------------------------------------------------------------
-- 5. Emailing the day-before confirmation instead
-- ---------------------------------------------------------------------------
--
-- The text is the normal way a customer is told we are coming tomorrow. When
-- a carrier refuses that text, the customer is not told at all — and unlike a
-- quote, which can wait, this one expires overnight. Two people arrive at a
-- house in the morning that was not expecting them.
--
-- So the webhook emails it instead, and this hands over what that needs.
-- Returns no row when there is no address, which is the caller's signal to
-- stop; a customer with neither a working phone nor an email is a phone call
-- somebody has to make, and the failures list is where they find out.

drop function if exists public.reminder_for_email(uuid);

create function public.reminder_for_email(p_job_id uuid)
returns table (
  out_name      text,
  out_email     text,
  out_starts_at timestamptz,
  out_address   text,
  out_services  text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(c.name, l.name, 'there'),
    coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')),
    j.starts_at,
    coalesce(nullif(btrim(c.address), ''), nullif(btrim(l.address), '')),
    j.services
  from public.jobs j
  left join public.leads     l on l.id = j.lead_id
  left join public.customers c on c.id = j.customer_id
  where j.id = p_job_id
    -- Only a job that is still going to happen. A cancelled job whose
    -- reminder text bounced must not be confirmed by email afterwards.
    and j.status = 'scheduled'
    and j.starts_at > now()
    and coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')) is not null
$$;

-- ---------------------------------------------------------------------------
-- 6. One list of everything that did not arrive
-- ---------------------------------------------------------------------------
--
-- Texts and emails together, because the question a person has is "did this
-- customer hear from us", and that question does not know which channel was
-- tried. Two lists side by side would mean a customer whose text bounced AND
-- whose email bounced appears once in each, looking like two small problems
-- instead of one person nobody has reached.
--
-- sms_failures stays exactly as it was. It is the texts-only view, it is what
-- verify/sms-delivery-live.sql checks, and there is no reason to break it to
-- add a second one alongside.
--
-- security_invoker so the view obeys the policies on the tables underneath
-- rather than its owner's rights — see db/rls-phase-1b.sql for what happens
-- without it.

create or replace view public.delivery_failures as
  select
    'text'::text                          as channel,
    -- As text, because sms_messages.id is a bigint identity and
    -- sent_emails.id is a uuid. A union needs one type, and the only thing
    -- anything does with this is use it as a React key alongside channel.
    s.id::text                            as id,
    s.created_at,
    s.status,
    s.kind,
    s.phone                               as to_addr,
    s.body                                as detail,
    s.error,
    s.provider_sid                        as provider_ref,
    public.sb_sms_permanent(s.error)      as permanent,
    (u.phone is not null and u.cleared_at is null) as blocked,
    false                                 as complained,
    s.lead_id,
    s.customer_id,
    s.quote_id,
    s.job_id,
    coalesce(c.name, l.name)              as who,
    -- The number we tried IS the number to call back.
    s.phone                               as phone,
    coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')) as email,
    j.starts_at                           as job_at
  from public.sms_messages s
  left join public.sms_unreachable u on u.phone = s.phone
  left join public.leads     l on l.id = s.lead_id
  left join public.customers c on c.id = s.customer_id
  left join public.jobs      j on j.id = s.job_id
  where s.direction = 'out'
    and s.status in ('undelivered', 'failed')

  union all

  select
    'email'::text,
    e.id::text,
    e.created_at,
    e.status,
    e.kind,
    e.to_email,
    -- The subject line, which is what identifies the message to a person.
    e.subject,
    e.error,
    e.provider_id,
    (e.status = 'complained') or public.sb_email_permanent(e.error),
    (m.email is not null and m.cleared_at is null),
    coalesce(m.complained, e.status = 'complained'),
    e.lead_id,
    e.customer_id,
    e.quote_id,
    e.job_id,
    coalesce(c.name, l.name),
    -- For an email failure the useful thing is the PHONE — the whole point
    -- of showing it is that somebody has to reach this person another way.
    coalesce(nullif(btrim(c.phone), ''), nullif(btrim(l.phone), '')),
    e.to_email,
    j.starts_at
  from public.sent_emails e
  left join public.email_unreachable m on m.email = e.to_email
  left join public.leads     l on l.id = e.lead_id
  left join public.customers c on c.id = e.customer_id
  left join public.jobs      j on j.id = e.job_id
  where e.status in ('bounced', 'complained', 'failed');

alter view public.delivery_failures set (security_invoker = true);

comment on view public.delivery_failures is
  'Everything the CRM tried to send and could not deliver, texts and emails
   in one list. channel says which.';

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

grant select on public.sent_emails        to authenticated;
grant select on public.email_unreachable  to authenticated;
grant select on public.delivery_failures  to authenticated;

grant execute on function public.sb_email_norm(text)              to authenticated;
grant execute on function public.sb_email_permanent(text)         to authenticated;
grant execute on function public.sb_email_unreachable(text)       to authenticated;
grant execute on function public.clear_email_unreachable(text, uuid) to authenticated;

-- Deliberately NOT granted to authenticated: record_email_sent,
-- mark_email_failed, mark_email_delivered and reminder_for_email. Every one
-- of them is called by a Netlify function holding the service role. A signed
-- in browser being able to invent a bounce, or read a customer's email
-- address out of a job it has no policy to see, is not a capability the UI
-- needs and not one worth handing out.
