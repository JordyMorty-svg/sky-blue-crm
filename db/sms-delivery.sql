-- ===========================================================================
-- Knowing when a text did NOT arrive
-- ===========================================================================
--
-- Run once, after db/sms.sql. Safe to run twice.
--
-- The gap this closes
-- -------------------
-- Sending a text is two separate events and the CRM only ever saw the first.
-- Quo accepts the message and answers 202 with an id; the carrier decides
-- whether it can be delivered a second or two later, and says so on a
-- webhook. netlify/lib/sms.mjs marked the row 'sent' on the 202 and nothing
-- listened for the rest, so a quote to a landline was recorded as sent and
-- looked, from inside the CRM, exactly like one the customer had read.
--
-- That is how a $449 quote to Judy sat on the board as delivered while the
-- carrier had rejected it outright with "destination not found".
--
-- Why 'undelivered' and not 'failed'
-- ----------------------------------
-- sms.sql already has a 'failed' status, and it would be the obvious place
-- to put this. It is the wrong place, and the reason is one line in that
-- file:
--
--     where dedupe_key is not null and status in ('queued', 'sent')
--
-- The double-send guard only covers rows in those two states. A 'failed' row
-- deliberately drops OUT of the index so it can be retried, which is right
-- for its actual meaning: the run died before handing the message over, so
-- nobody has seen it and sending again is safe.
--
-- A carrier rejection is the opposite. The message was handed over and
-- refused, and the refusal is a property of the NUMBER, not of the attempt.
-- Marking it 'failed' would free the dedupe slot and the nightly run would
-- cheerfully text that landline again, and again, every night, forever.
--
-- So: 'failed' means we never got it to the carrier and a retry is safe.
-- 'undelivered' means the carrier took it and said no, and a retry is not.
-- The index below covers both 'sent' and 'undelivered' for exactly that
-- reason.

-- ---------------------------------------------------------------------------
-- 1. The new state
-- ---------------------------------------------------------------------------

alter table public.sms_messages
  drop constraint if exists sms_messages_status_check;

alter table public.sms_messages
  add constraint sms_messages_status_check
  check (status in ('queued', 'sent', 'undelivered', 'failed', 'received'));

-- The guard, widened. This index and the ON CONFLICT clause inside
-- claim_sms() have to state the same predicate or the conflict is not
-- detected at all — so they are changed together, below, and never apart.
drop index if exists public.sms_messages_dedupe_idx;
create unique index sms_messages_dedupe_idx
  on public.sms_messages (dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'sent', 'undelivered');

create index if not exists sms_messages_undelivered_idx
  on public.sms_messages (created_at desc)
  where status = 'undelivered';

-- ---------------------------------------------------------------------------
-- 2. Numbers that cannot receive a text
-- ---------------------------------------------------------------------------
--
-- Per NUMBER, not per lead or per customer. The same phone belongs to a lead
-- before they book and a customer afterwards, and it is the number that
-- can't receive texts — recording it on one row would leave the other one
-- still trying.
--
-- Not a flag on a table anyone edits by hand, either: this is evidence the
-- carrier gave us, and it should read as evidence.

create table if not exists public.sms_unreachable (
  phone        text primary key,

  -- The carrier's own words, kept verbatim. "destination not found" and
  -- "landline or unreachable" mean the same thing to us but not to whoever
  -- reads this in six months wondering whether it was really permanent.
  reason       text,

  failures     int not null default 1,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),

  -- Set when a person says "try it again" — they got a new phone, or the
  -- number was a typo that has since been fixed. A cleared row stays for
  -- the history; sb_sms_unreachable() ignores it.
  cleared_at   timestamptz,
  cleared_by   uuid references public.profiles (id) on delete set null
);

comment on table public.sms_unreachable is
  'Numbers a carrier has permanently refused to deliver to — landlines,
   disconnected lines. Checked by claim_sms() in the same breath as the
   opt-out list, and for the same reason: continuing to try is worse than
   useless, because it looks like it worked.';

alter table public.sms_unreachable enable row level security;

drop policy if exists sms_unreachable_staff_read on public.sms_unreachable;
create policy sms_unreachable_staff_read
  on public.sms_unreachable for select to authenticated using (true);

-- Cleared by a person, from the UI. Written only by the webhook, which
-- arrives as the service role and bypasses RLS.
drop policy if exists sms_unreachable_staff_update on public.sms_unreachable;
create policy sms_unreachable_staff_update
  on public.sms_unreachable for update to authenticated using (true);

create or replace function public.sb_sms_unreachable(p_phone text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.sms_unreachable u
     where u.phone = public.sb_sms_e164(p_phone)
       and u.cleared_at is null
  )
$$;

-- ---------------------------------------------------------------------------
-- 3. Which refusals are permanent
-- ---------------------------------------------------------------------------
--
-- Deliberately narrow. A number is only marked unreachable for reasons that
-- are about the DESTINATION — it does not exist, it cannot receive SMS, it
-- is disconnected. Everything else (spam filtering, rate limits, carrier
-- outages, "content flagged") is about this message on this day, and a
-- number must not be written off because of it.
--
-- When in doubt the answer is false: recording an undelivered message and
-- leaving the number alone costs nothing, and wrongly writing off a real
-- mobile means never texting a customer again.

create or replace function public.sb_sms_permanent(p_error text)
returns boolean
language sql
immutable
as $$
  select case
    when p_error is null then false
    else lower(p_error) ~
      '(destination not found|destination.*unknown|landline|unreachable|not sms|cannot receive|unallocated|disconnected|invalid (phone|number|destination)|no route)'
  end
$$;

comment on function public.sb_sms_permanent(text) is
  'True only for carrier errors about the destination itself. Spam
   filtering and rate limits are explicitly NOT permanent — see the note
   in db/sms-delivery.sql.';

-- ---------------------------------------------------------------------------
-- 4. Recording the carrier's verdict
-- ---------------------------------------------------------------------------
--
-- Keyed on provider_sid, because the webhook knows Quo's message id and
-- nothing else about our row.
--
-- Idempotent: webhooks are delivered at least once, and Quo retries on any
-- non-2xx. Running this twice must not double-count a failure, so the
-- update is guarded on the row not already being 'undelivered'.
--
-- Returns the row it changed so the caller can act on it — send the quote
-- by email instead, tell somebody. Returns nothing at all when there was
-- nothing to change, which is how the caller distinguishes a real failure
-- from a duplicate webhook.

-- Dropped first, not just replaced. CREATE OR REPLACE FUNCTION refuses to
-- change a return type, so once this function exists, editing its RETURNS
-- TABLE turns a re-run of this migration into "cannot change return type of
-- existing function" — halfway through, with everything above it applied.
-- A migration that cannot be run twice is one you cannot fix.
drop function if exists public.mark_sms_undelivered(text, text);

create function public.mark_sms_undelivered(
  p_sid   text,
  p_error text default null
)
-- Every returned column is prefixed. A plain `phone` here is an OUT
-- parameter that shadows the column of the same name on sms_unreachable,
-- and `on conflict (phone)` below then fails to resolve with "column
-- reference is ambiguous" — at runtime, on the first real carrier
-- rejection, long after anybody was watching. The prefix is ugly and it
-- makes that impossible.
returns table (
  out_id          bigint,
  out_phone       text,
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
  m public.sms_messages;
  is_permanent boolean;
begin
  if coalesce(btrim(p_sid), '') = '' then
    return;
  end if;

  update public.sms_messages s
     set status = 'undelivered',
         error  = coalesce(p_error, 'carrier did not deliver it')
   where s.provider_sid = p_sid
     and s.status <> 'undelivered'
  returning * into m;

  if m.id is null then
    return;  -- unknown sid, or this webhook already arrived
  end if;

  is_permanent := public.sb_sms_permanent(p_error);

  if is_permanent then
    insert into public.sms_unreachable (phone, reason)
    values (m.phone, p_error)
    on conflict (phone) do update
      set failures   = public.sms_unreachable.failures + 1,
          last_at    = now(),
          reason     = excluded.reason,
          -- A fresh permanent failure un-clears it. Somebody decided to try
          -- again, the carrier said no again, and that answer is newer than
          -- their decision.
          cleared_at = null;
  end if;

  -- The contact timeline already says this text went out, because
  -- mark_sms_sent() wrote that row when Quo accepted it. Say the rest, in
  -- the same columns and the same shape — sb_phone_digits for phone_norm,
  -- the reason in detail — so the two entries sit together and read as one
  -- story rather than two systems disagreeing.
  --
  -- No exception handler around this. The first version had one, "because
  -- contact_log is only a nicety here", and it silently swallowed the fact
  -- that the insert named columns this table does not have. A write that is
  -- allowed to fail quietly is a write nobody will ever know is broken.
  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail, created_at
  )
  values (
    m.lead_id, m.customer_id, public.sb_phone_digits(m.phone),
    'text_undelivered', coalesce(p_error, 'carrier did not deliver it'), now()
  );

  return query
    select m.id, m.phone, m.kind, m.lead_id, m.customer_id,
           m.quote_id, m.job_id, is_permanent;
end;
$$;

-- Letting a number back in. Deliberately a function rather than an UPDATE
-- from the app, so the "who and when" is always recorded.
drop function if exists public.clear_sms_unreachable(text, uuid);

create function public.clear_sms_unreachable(
  p_phone text,
  p_by    uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  e164 text := public.sb_sms_e164(p_phone);
  n    int;
begin
  if e164 is null then return false; end if;

  update public.sms_unreachable
     set cleared_at = now(), cleared_by = coalesce(p_by, auth.uid())
   where phone = e164 and cleared_at is null;

  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The gate
-- ---------------------------------------------------------------------------
--
-- claim_sms() again, with one check added and the ON CONFLICT predicate
-- widened to match the new index. Everything else is character-for-character
-- what db/sms.sql defines — it is repeated in full because CREATE OR REPLACE
-- FUNCTION has no way to add a line to an existing body.
--
-- The unreachable check sits immediately after the opt-out check and, like
-- it, is NOT overridable by p_force. Pressing the button harder does not
-- give a landline the ability to receive a text; all it would do is write a
-- row saying we sent something that cannot have arrived.

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

  if public.sb_sms_opted_out(e164) then
    return query select null::bigint, false, 'opted_out', e164;
    return;
  end if;

  -- New. See the note above for why p_force does not reach this.
  if public.sb_sms_unreachable(e164) then
    return query select null::bigint, false, 'unreachable', e164;
    return;
  end if;

  if not p_force and public.sb_sms_quiet_now() then
    return query select null::bigint, false, 'quiet_hours', e164;
    return;
  end if;

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
    where dedupe_key is not null
      and status in ('queued', 'sent', 'undelivered')
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
-- 5b. Everything needed to send a quote the other way
-- ---------------------------------------------------------------------------
--
-- When a quote text is refused, the CRM emails it instead — but the webhook
-- knows only Quo's message id. This hands back the rest.
--
-- In SQL rather than in the function, for the same reason sms_failures is:
-- "which of the lead and the customer is the person here, and do they have
-- an email" is a question this schema answers, and answering it a second
-- time in JavaScript is how the two drift apart.
--
-- Returns no row when there is no address to send to, which is the caller's
-- signal to stop rather than a failure. A lead with no email is ordinary.

drop function if exists public.quote_for_email(uuid);

create function public.quote_for_email(p_quote_id uuid)
returns table (
  out_token     text,
  out_name      text,
  out_email     text,
  out_amount    numeric,
  out_expires   timestamptz
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
    q.expires_at
  from public.quotes q
  left join public.leads     l on l.id = q.lead_id
  left join public.customers c on c.id = q.customer_id
  where q.id = p_quote_id
    and coalesce(nullif(btrim(c.email), ''), nullif(btrim(l.email), '')) is not null
$$;

grant execute on function public.quote_for_email(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The list to work through
-- ---------------------------------------------------------------------------
--
-- Everything that did not arrive, newest first, with enough of the person
-- attached to act on it without another lookup. security_invoker so it
-- obeys the policies on the tables underneath rather than the owner's
-- rights — see db/rls-phase-1b.sql, where a view without this was how the
-- anon key could read the leads table.

create or replace view public.sms_failures as
  select
    s.id,
    s.created_at,
    s.status,
    s.kind,
    s.phone,
    s.body,
    s.error,
    -- Quo's own id for the message. The one thing their support will ask
    -- for if a delivery ever needs chasing, and the only handle that ties a
    -- row here to a message in their app.
    s.provider_sid,
    public.sb_sms_permanent(s.error) as permanent,
    (u.phone is not null and u.cleared_at is null) as number_blocked,
    s.lead_id,
    s.customer_id,
    s.quote_id,
    s.job_id,
    coalesce(c.name, l.name)   as who,
    coalesce(c.email, l.email) as email
  from public.sms_messages s
  left join public.sms_unreachable u on u.phone = s.phone
  left join public.leads     l on l.id = s.lead_id
  left join public.customers c on c.id = s.customer_id
  where s.direction = 'out'
    and s.status in ('undelivered', 'failed')
  order by s.created_at desc;

alter view public.sms_failures set (security_invoker = true);

comment on view public.sms_failures is
  'Texts that did not arrive. Includes failed (never reached the carrier,
   safe to retry) as well as undelivered (the carrier refused it).';

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

grant select on public.sms_unreachable to authenticated;
grant select on public.sms_failures    to authenticated;
grant execute on function public.sb_sms_unreachable(text)   to authenticated;
grant execute on function public.sb_sms_permanent(text)     to authenticated;
grant execute on function public.clear_sms_unreachable(text, uuid) to authenticated;
