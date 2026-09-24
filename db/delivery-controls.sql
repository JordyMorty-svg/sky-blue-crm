-- ===========================================================================
-- Asking Quo what happened, and clearing up what we know
-- ===========================================================================
--
-- Run after db/email-delivery.sql. Safe to run twice.
--
-- NOTE: no `\set ON_ERROR_STOP on` here. That is a psql meta-command, not
-- SQL. The Supabase editor sends what you paste straight to Postgres, which
-- answers `ERROR: 42601: syntax error at or near "\"` on line 1 and runs
-- nothing. Every file in db/ is plain SQL; the flag belongs in verify/*.sql,
-- which are run through psql.
--
-- Three things, all of them things the last migration got wrong or left out.
--
-- 1. THE WEBHOOK DOES NOT EXIST
-- -----------------------------
-- db/sms-delivery.sql was built around Quo posting a `message.failed` event.
-- It doesn't. Quo publishes exactly two message webhooks:
--
--     message.received    a customer texted us
--     message.delivered   one of ours arrived
--
-- There is no failure event to subscribe to, so the delivery branch in
-- sms-inbound.mjs has been sitting there waiting for something that is never
-- coming. That is why a quote to a landline still says "sent" days later:
-- nothing was ever going to tell us otherwise.
--
-- What Quo DOES have is the status on the message itself.
-- GET /v1/messages/{id} returns one of:
--
--     queued | sent | delivered | undelivered | received
--
-- So the CRM has to ASK. We already store Quo's id in provider_sid on every
-- send, which is the handle that makes this possible — it was put there for
-- the webhook and turns out to be the thing that actually works.
--
-- Asking also makes it RETROACTIVE, which a webhook could never be. Every
-- quote already sent gets its real verdict on the first run.
--
-- 2. 'delivered' IS NOT A NEW STATUS
-- ----------------------------------
-- The obvious move is to add 'delivered' to the status check. It is a trap,
-- and it is the same trap 'undelivered' was invented to avoid.
--
-- The double-send guard is a unique index over
--
--     status in ('queued', 'sent', 'undelivered')
--
-- A row that moved to 'delivered' would drop OUT of that index, freeing the
-- dedupe slot — and the nightly run would cheerfully send the same quote
-- again, to somebody who has already read it. Confirming delivery would
-- cause a double send. Nothing would error.
--
-- So delivery is recorded as a TIMESTAMP on the row, not as a status. The
-- status vocabulary and the index are untouched.
--
-- 3. THE LIST HAS TO BE CLEARABLE
-- -------------------------------
-- A failures list nobody can clear stops being read. Two ways it fills with
-- things that are not problems:
--
--   * test sends from before A2P approval, whose leads have since been
--     deleted. They show as "Unknown" with no record to open — there is
--     literally nothing a person can do with one.
--   * a real failure somebody has already dealt with by phoning the customer.
--
-- Dismissing hides the row. It does NOT delete it: sms_messages is the
-- record of what this business sent to which number, which is what answers a
-- carrier complaint, and "we tidied the screen" is not a reason to lose it.

-- ---------------------------------------------------------------------------
-- 1. What we know about a send, beyond what we guessed
-- ---------------------------------------------------------------------------

alter table public.sms_messages
  add column if not exists delivered_at timestamptz;

comment on column public.sms_messages.delivered_at is
  'When Quo confirmed the handset got it. A timestamp and not a status,
   because a status change would drop the row out of the double-send index
   and free the dedupe slot — see the header of db/delivery-controls.sql.';

alter table public.sms_messages
  add column if not exists dismissed_at timestamptz;

alter table public.sms_messages
  add column if not exists dismissed_by uuid references public.profiles (id) on delete set null;

comment on column public.sms_messages.dismissed_at is
  'Hidden from the failures list by a person who has dealt with it. The row
   itself is never deleted.';

-- The reconciler''s working set: sent, never confirmed, recent enough to be
-- worth asking about. Partial, so it stays tiny however big the table gets.
create index if not exists sms_messages_unverified_idx
  on public.sms_messages (created_at)
  where status = 'sent'
    and delivered_at is null
    and provider_sid is not null;

-- ---------------------------------------------------------------------------
-- 2. Which sends to ask Quo about
-- ---------------------------------------------------------------------------
--
-- Oldest first. If there is a backlog, the messages closest to falling out
-- of the window are the ones that get answered before they do.
--
-- Bounded by p_days because Quo's answer stops changing: a message that has
-- been 'sent' for a week is not about to become 'delivered', and asking
-- about it forever is a request per message per night, indefinitely, for an
-- answer nobody is waiting for.

create or replace function public.sms_awaiting_verdict(
  p_limit int default 100,
  p_days  int default 7
)
returns table (
  out_id  bigint,
  out_sid text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.provider_sid
  from public.sms_messages s
  where s.status = 'sent'
    and s.delivered_at is null
    and s.provider_sid is not null
    and s.created_at > now() - (p_days || ' days')::interval
  order by s.created_at
  limit p_limit
$$;

comment on function public.sms_awaiting_verdict(int, int) is
  'Messages Quo has accepted but never confirmed either way. The reconciler
   asks about these; there is no webhook that would tell us.';

-- ---------------------------------------------------------------------------
-- 3. It arrived
-- ---------------------------------------------------------------------------
--
-- Called from two places that must agree: the reconciler, and the
-- message.delivered webhook — which is a real Quo event and worth
-- subscribing to, because every delivery it confirms is a message the
-- reconciler then never has to ask about.
--
-- Idempotent. The webhook and the reconciler will often both report the same
-- message and only the first one changes anything.

create or replace function public.mark_sms_delivered(p_sid text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sms_messages
     set delivered_at = now()
   where provider_sid = nullif(btrim(coalesce(p_sid, '')), '')
     and delivered_at is null
     and status = 'sent'
  returning true
$$;

-- ---------------------------------------------------------------------------
-- 4. Dealt with
-- ---------------------------------------------------------------------------

create or replace function public.dismiss_sms_failure(
  p_id bigint,
  p_by uuid default auth.uid()
)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sms_messages
     set dismissed_at = now(), dismissed_by = p_by
   where id = p_id
     and dismissed_at is null
     -- Only a row that is actually on the list. Dismissing a message that
     -- went through fine would hide nothing and silently mark a healthy
     -- send as handled.
     and status in ('undelivered', 'failed')
  returning true
$$;

create or replace function public.undismiss_sms_failure(p_id bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sms_messages
     set dismissed_at = null, dismissed_by = null
   where id = p_id and dismissed_at is not null
  returning true
$$;

-- The same, for an email that bounced. sent_emails.id is a uuid where
-- sms_messages.id is a bigint, so these are two functions and not one.
alter table public.sent_emails
  add column if not exists dismissed_at timestamptz;

alter table public.sent_emails
  add column if not exists dismissed_by uuid references public.profiles (id) on delete set null;

create or replace function public.dismiss_email_failure(
  p_id uuid,
  p_by uuid default auth.uid()
)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sent_emails
     set dismissed_at = now(), dismissed_by = p_by
   where id = p_id
     and dismissed_at is null
     and status in ('bounced', 'complained', 'failed')
  returning true
$$;

create or replace function public.undismiss_email_failure(p_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.sent_emails
     set dismissed_at = null, dismissed_by = null
   where id = p_id and dismissed_at is not null
  returning true
$$;

-- ---------------------------------------------------------------------------
-- 5. Deleting a quote
-- ---------------------------------------------------------------------------
--
-- An ACCEPTED quote cannot be deleted, and this is the whole reason the
-- delete goes through a function instead of being a DELETE from the browser.
--
-- Accepting is what creates the job and what the commission trigger reads to
-- decide who gets the booking fee. Deleting an accepted quote removes the
-- evidence of a payment somebody is owed, and it removes it from the person
-- who is owed it — quietly, with the job still sitting on the calendar.
--
-- A draft, a sent quote, a viewed one or a declined one has nothing hanging
-- off it. Those go.
--
-- Raises rather than returning false. The caller is a button on a screen and
-- the message is written for the person pressing it.

create or replace function public.delete_quote(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes;
begin
  select * into q from public.quotes where id = p_id;

  if q.id is null then
    -- Already gone. Not an error: two clicks on one button, or two people
    -- tidying at once, and the end state is the one that was wanted.
    return false;
  end if;

  if q.status = 'accepted' then
    raise exception
      'That quote was accepted, so it has a job and a booking fee attached. '
      'Cancel the job first if it is not going ahead.';
  end if;

  -- The texts about it are kept and unlinked, not deleted. quote_id is
  -- `on delete set null` for the same reason the lead link is: the record
  -- that this number was texted has to survive the tidying up, or the
  -- opt-out and complaint history goes with it.
  delete from public.quotes where id = p_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The list, with the noise taken out
-- ---------------------------------------------------------------------------
--
-- Two exclusions on top of what db/email-delivery.sql already had.
--
-- DISMISSED rows, obviously.
--
-- ORPHANS: a row whose lead and customer are both gone. quotes cascade when
-- a lead is deleted, but sms_messages deliberately does not — it nulls the
-- links instead — so a deleted test lead leaves a failure row with no name,
-- no record to open and nothing anybody can do about it. It is not a task.
-- It is a tombstone, and it belongs in the table and not on the screen.
--
-- Inbound and internal rows were never in scope; the where clause already
-- handles that.

create or replace view public.delivery_failures as
  select
    'text'::text                          as channel,
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
    and s.dismissed_at is null
    and (s.lead_id is not null or s.customer_id is not null)

  union all

  select
    'email'::text,
    e.id::text,
    e.created_at,
    e.status,
    e.kind,
    e.to_email,
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
    coalesce(nullif(btrim(c.phone), ''), nullif(btrim(l.phone), '')),
    e.to_email,
    j.starts_at
  from public.sent_emails e
  left join public.email_unreachable m on m.email = e.to_email
  left join public.leads     l on l.id = e.lead_id
  left join public.customers c on c.id = e.customer_id
  left join public.jobs      j on j.id = e.job_id
  where e.status in ('bounced', 'complained', 'failed')
    and e.dismissed_at is null
    and (e.lead_id is not null or e.customer_id is not null);

alter view public.delivery_failures set (security_invoker = true);

comment on view public.delivery_failures is
  'Everything the CRM tried to send and could not deliver, texts and emails
   in one list, minus what has been dismissed and what belongs to a record
   that no longer exists. channel says which.';

-- What has been dismissed, so it can be looked at and put back. Not shown by
-- default; a screen that hides things with no way to see what it hid is a
-- screen nobody trusts.
create or replace view public.delivery_dismissed as
  select 'text'::text as channel, s.id::text as id, s.created_at,
         s.status, s.kind, s.phone as to_addr, s.body as detail, s.error,
         s.dismissed_at, s.dismissed_by,
         coalesce(c.name, l.name) as who
    from public.sms_messages s
    left join public.leads     l on l.id = s.lead_id
    left join public.customers c on c.id = s.customer_id
   where s.dismissed_at is not null
  union all
  select 'email', e.id::text, e.created_at,
         e.status, e.kind, e.to_email, e.subject, e.error,
         e.dismissed_at, e.dismissed_by,
         coalesce(c.name, l.name)
    from public.sent_emails e
    left join public.leads     l on l.id = e.lead_id
    left join public.customers c on c.id = e.customer_id
   where e.dismissed_at is not null;

alter view public.delivery_dismissed set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

grant select on public.delivery_dismissed to authenticated;

-- Pressed by a person, in the browser.
grant execute on function public.dismiss_sms_failure(bigint, uuid)   to authenticated;
grant execute on function public.undismiss_sms_failure(bigint)       to authenticated;
grant execute on function public.dismiss_email_failure(uuid, uuid)   to authenticated;
grant execute on function public.undismiss_email_failure(uuid)       to authenticated;
grant execute on function public.delete_quote(uuid)                  to authenticated;

-- Called by the reconciler, which runs as the service role. Deliberately not
-- granted to authenticated: a signed-in browser has no business declaring a
-- message delivered.
grant execute on function public.sms_awaiting_verdict(int, int) to service_role;
grant execute on function public.mark_sms_delivered(text)       to service_role;
