-- db/quotes.sql
--
-- Quotes you can send to a lead or a customer, which they can accept from
-- their phone. Accepting moves the lead to Booked in the CRM by itself.
--
-- Run AFTER: lead-events.sql, commissions.sql. This file amends a function
-- that lead-events.sql owns (see "the actor override" below), so re-running
-- lead-events.sql later will undo that amendment — re-run this file after if
-- you ever do. Idempotent; safe to run repeatedly.
--
-- ---------------------------------------------------------------------------
-- The security model, stated plainly
-- ---------------------------------------------------------------------------
--
-- The customer is not logged in. They have a link and nothing else. So:
--
--   * The public token is 32 random bytes, not the row id. Sequential ids
--     would let anyone who received one quote walk the whole table.
--   * `quotes` gets RLS that admits ONLY signed-in staff. The public page
--     never touches the table — it goes through a Netlify function holding
--     the service key, which calls the two functions at the bottom of this
--     file and returns nothing else.
--   * sb_quote_public() returns a deliberately narrow row. No customer id,
--     no phone, no lead history, no internal notes. Someone who guesses a
--     token (they will not) learns one price and one address.
--
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- The table
-- --------------------------------------------------------------------------

create table if not exists public.quotes (
  id           uuid primary key default gen_random_uuid(),

  -- 64 hex characters. What goes in the link.
  token        text not null unique default encode(gen_random_bytes(32), 'hex'),

  -- A quote hangs off a lead, a customer, or both. A lead is the usual case
  -- (someone who hasn't bought yet); a customer is repeat work. At least one
  -- must be present, or the quote is about nobody.
  lead_id      uuid references public.leads(id) on delete cascade,
  customer_id  uuid references public.customers(id) on delete cascade,

  -- Snapshotted, not joined. A quote is an offer made at a moment: if the
  -- lead's address is corrected next week, the quote the customer is looking
  -- at must still say what it said when they got it.
  customer_name text not null,
  address       text,
  service_keys  text[] not null default '{}',
  amount        numeric(10,2) not null check (amount >= 0),
  note          text,

  status       text not null default 'draft'
                 check (status in ('draft','sent','viewed','accepted','declined')),

  -- Who to pay the booking fee to when the customer accepts it themselves.
  -- Without this the fee goes to nobody: the commission trigger reads
  -- lead_events.changed_by, and a customer tapping a link has no auth.uid().
  sent_by      uuid references public.profiles(id),

  expires_at   timestamptz not null default (now() + interval '30 days'),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  viewed_at    timestamptz,
  accepted_at  timestamptz,
  declined_at  timestamptz,

  constraint quotes_has_subject check (lead_id is not null or customer_id is not null)
);

create index if not exists quotes_lead_idx     on public.quotes (lead_id);
create index if not exists quotes_customer_idx on public.quotes (customer_id);
create index if not exists quotes_status_idx   on public.quotes (status);

-- --------------------------------------------------------------------------
-- The actor override
-- --------------------------------------------------------------------------
--
-- lead-events.sql resolves the acting user from auth.uid(). That is right for
-- every change made in the CRM, and useless for this one: the customer
-- accepting a quote is not a CRM user at all, so auth.uid() is null, the
-- event records no actor, and the booking commission is created for nobody
-- and silently skipped.
--
-- So a SECURITY DEFINER function acting on behalf of a real person can now
-- name them, by setting `sb.actor` first. It is transaction-local (the third
-- argument to set_config), so it cannot leak into the next statement, and
-- auth.uid() still wins for every ordinary path because nothing else sets it.
create or replace function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor    uuid;
  claimed  uuid;
begin
  -- An explicitly claimed actor (set by sb_accept_quote), else the session.
  begin
    claimed := nullif(current_setting('sb.actor', true), '')::uuid;
  exception when others then
    -- A malformed setting must never block a status change. History is
    -- allowed to be incomplete; the CRM is not allowed to stop working.
    claimed := null;
  end;

  select p.id into actor
    from public.profiles p
   where p.id = coalesce(claimed, auth.uid());

  if tg_op = 'INSERT' then
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, actor);
    return new;
  end if;

  -- Only log real transitions. Saving the lead detail form rewrites every
  -- column, so without this guard every edit would create a noise event.
  if new.status is distinct from old.status then
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, actor);
  end if;

  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- What the public page is allowed to see
-- --------------------------------------------------------------------------
--
-- Note what is NOT returned: customer_id, lead_id, phone, email, the internal
-- note, who sent it, anything about other jobs. A token is a capability to
-- read one price, and that is all it buys.
--
-- Also records the view. Knowing a quote was opened and not accepted is worth
-- a follow-up text; knowing it was never opened is worth resending.
drop function if exists public.sb_quote_public(text);

create or replace function public.sb_quote_public(p_token text)
returns table (
  customer_name text,
  address       text,
  service_keys  text[],
  amount        numeric,
  note          text,
  status        text,
  expires_at    timestamptz,
  expired       boolean,
  accepted_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
begin
  select * into q from public.quotes where quotes.token = p_token;
  if not found then
    return; -- zero rows: the caller can't tell a bad token from a deleted one
  end if;

  -- First open. Only moves sent -> viewed; never walks an accepted quote
  -- backwards just because the customer opened the link again.
  if q.status = 'sent' then
    update public.quotes
       set status = 'viewed', viewed_at = coalesce(viewed_at, now())
     where id = q.id;
    q.status := 'viewed';
  end if;

  return query select
    q.customer_name, q.address, q.service_keys, q.amount, q.note, q.status,
    q.expires_at,
    -- Computed, not stored. A nightly job to flip expired quotes would be a
    -- cron that can fail; a comparison cannot.
    (now() > q.expires_at) as expired,
    q.accepted_at;
end;
$$;

-- --------------------------------------------------------------------------
-- Accepting
-- --------------------------------------------------------------------------
--
-- Idempotent on purpose. Customers double-tap, links get opened twice, phones
-- retry on flaky signal. A second accept returns the same success and books
-- nothing further; it must never create two lead events and so two booking
-- fees.
drop function if exists public.sb_accept_quote(text);

create or replace function public.sb_accept_quote(p_token text)
returns table (ok boolean, reason text, already boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
begin
  -- Locked: two taps landing together would otherwise both pass the status
  -- check and both update the lead.
  select * into q from public.quotes where quotes.token = p_token for update;

  if not found then
    return query select false, 'not_found', false;
    return;
  end if;

  if q.status = 'accepted' then
    return query select true, 'already_accepted', true;
    return;
  end if;

  if q.status = 'declined' then
    return query select false, 'declined', false;
    return;
  end if;

  if now() > q.expires_at then
    return query select false, 'expired', false;
    return;
  end if;

  update public.quotes
     set status = 'accepted', accepted_at = now()
   where id = q.id;

  -- Attribute the booking to whoever sent the quote. See the long note above
  -- log_lead_status_change: without this the fee is created for a null
  -- profile and dropped.
  if q.sent_by is not null then
    perform set_config('sb.actor', q.sent_by::text, true);
  end if;

  -- A quote against a lead moves it to Booked, which is what fires the
  -- booking commission through the existing lead_events trigger. A quote
  -- against an existing customer has no lead to move — repeat work goes
  -- straight to scheduling — so it just records the acceptance.
  if q.lead_id is not null then
    update public.leads
       set status = 'booked',
           -- The accepted amount IS the price now. Leaving a stale estimate
           -- would have the commission calculate against a number the
           -- customer never agreed to.
           estimate = q.amount
     where id = q.lead_id
       and status not in ('booked', 'scheduled', 'completed');
  end if;

  return query select true, 'accepted', false;
end;
$$;

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------
--
-- Staff only. The public page reaches quotes exclusively through the two
-- SECURITY DEFINER functions above, called by a Netlify function that holds
-- the service key — so there is no anon-readable path to this table at all.

alter table public.quotes enable row level security;

drop policy if exists quotes_staff_read on public.quotes;
create policy quotes_staff_read on public.quotes
  for select to authenticated using (true);

drop policy if exists quotes_staff_write on public.quotes;
create policy quotes_staff_write on public.quotes
  for insert to authenticated with check (true);

-- Update is narrower than insert: staff may withdraw a quote they sent, but
-- marking one ACCEPTED is the customer's act alone and belongs to
-- sb_accept_quote. Letting the app write that status directly would make the
-- audit trail meaningless.
drop policy if exists quotes_staff_update on public.quotes;
create policy quotes_staff_update on public.quotes
  for update to authenticated
  using (true)
  with check (status in ('draft', 'sent', 'declined'));

grant execute on function public.sb_quote_public(text)  to anon, authenticated;
grant execute on function public.sb_accept_quote(text)  to anon, authenticated;
