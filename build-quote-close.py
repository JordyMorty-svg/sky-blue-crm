# Generates db/quote-close.sql from the current db/quotes.sql.
#
# sb_accept_quote() has to gain one guard, and CREATE OR REPLACE needs the
# whole function to do it. Retyping sixty lines to add four is how the
# expiry check, or the lead-moves-to-booked block, or the sb.actor line that
# makes the booking commission land, quietly stops existing.
#
# So the function is EXTRACTED from db/quotes.sql and the guard inserted,
# with the insertion point asserted to exist first and every other guard
# asserted to survive. Same discipline as build-invoice-truth.py, for the
# same reason.

import sys

src = open("db/quotes.sql", encoding="utf-8").read()

START = "create or replace function public.sb_accept_quote(p_token text)"
start = src.index(START)
end = src.index("\n$$;", start) + len("\n$$;")
fn = src[start:end]

# The new guard goes immediately after the declined check, so the refusals
# read in the order a reader would expect: gone, done, refused by them,
# withdrawn by us, out of time.
ANCHOR = """  if q.status = 'declined' then
    return query select false, 'declined', false;
    return;
  end if;
"""

GUARD = """
  -- Withdrawn by us.
  --
  -- THIS IS WHY CLOSING A QUOTE IS NOT JUST A LABEL. A quote link is a
  -- standing offer: the token keeps working, and anybody holding the URL can
  -- accept it months later and create a real job with a real booking fee
  -- against it. Jeff Krueger has an $1,800 pressure-washing quote sitting in
  -- a text message that was superseded by the work actually done.
  --
  -- Hiding the Accept button is not enough -- that is a button, and this is
  -- an endpoint. The refusal belongs here, where the acceptance is decided.
  if q.status = 'closed' then
    return query select false, 'closed', false;
    return;
  end if;
"""

if ANCHOR not in fn:
    sys.exit("REFUSING TO BUILD: cannot find the declined guard in "
             "sb_accept_quote. Look at db/quotes.sql by hand.")

fn_new = fn.replace(ANCHOR, ANCHOR + GUARD, 1)
assert fn_new != fn

# Everything the extraction must not have lost. Each of these is a guard or a
# side effect that would fail silently rather than error.
for marker, why in [
    ("'not_found'", "the unknown-token refusal"),
    ("'already_accepted'", "the idempotent re-accept"),
    ("'declined'", "the customer's own refusal"),
    ("'expired'", "the expiry check"),
    ("for update", "the row lock that stops a double-accept"),
    ("set_config('sb.actor'", "the actor that makes the booking commission land"),
    ("status = 'booked'", "moving the lead to Booked"),
    ("estimate = q.amount", "the price the customer actually agreed to"),
]:
    assert marker in fn_new, f"lost {why} ({marker}) from sb_accept_quote"

HEADER = """-- Sky Blue CRM -- closing a quote that is no longer needed
--
-- Run once in the Supabase SQL editor, AFTER db/quotes.sql.
-- Safe to re-run. Plain SQL: no psql meta-commands.
--
-- The gap this fills
-- ------------------
-- Two quotes went to Jeff Krueger: $1,800 for pressure washing, and $1,180
-- for windows and gutters. The second was accepted and the work was billed
-- as one $3,280 job. The first is still sitting there, SENT, NOT OPENED YET.
--
-- There was nothing to do with it. Delete removes the record, which loses
-- the fact that the quote was made at all. Declined is the customer's word,
-- not ours, and counting it would quietly inflate the decline rate with
-- quotes nobody ever turned down. So there was no honest option, and the row
-- just sits on the customer page forever.
--
-- WHY THIS IS NOT COSMETIC. A quote link is a standing offer. The token
-- keeps working; anyone holding that text message can open it and accept
-- $1,800 of work months later, and sb_accept_quote will create the job and
-- the booking fee without a murmur. Closing it is what makes the offer
-- stop.
--
-- Asserted by verify/quote-close.sql, which is mutation-tested.
-- db/quote-close.sql is GENERATED from db/quotes.sql by build-quote-close.py.

-- ---------------------------------------------------------------------------
-- 1. The status, and who closed it
-- ---------------------------------------------------------------------------

-- A CHECK constraint is the reason this needs a migration at all. The same
-- trap as jobs.status: adding a state the application understands but the
-- database refuses produces an error from the far side of a save button.
alter table public.quotes drop constraint if exists quotes_status_check;

alter table public.quotes
  add constraint quotes_status_check
  check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined', 'closed'));

alter table public.quotes
  add column if not exists closed_at     timestamptz,
  add column if not exists closed_by     uuid references public.profiles (id) on delete set null,
  add column if not exists closed_reason text;

comment on column public.quotes.closed_at is
  'When this quote was withdrawn by us. Distinct from declined_at, which is
   the customer refusing it.';

-- ---------------------------------------------------------------------------
-- 2. Closing and reopening
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER rather than widening the RLS update policy, which allows
-- staff to write only draft / sent / declined. Going through a function
-- keeps that policy narrow AND puts the accepted-quote refusal in one place
-- where it can be given a sentence somebody can act on.
create or replace function public.close_quote(
  p_quote_id uuid,
  p_reason   text default null
)
returns table (
  out_quote_id uuid,
  out_status   text,
  out_closed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
  actor uuid;
begin
  select * into q from public.quotes where id = p_quote_id for update;

  if not found then
    raise exception 'That quote no longer exists.';
  end if;

  -- The same refusal delete_quote() makes, for the same reason: accepting is
  -- what creates the job and what the commission trigger reads to decide who
  -- gets the booking fee. Closing one would make a job sit on the calendar
  -- with its origin withdrawn, and take the evidence of a payment somebody
  -- is owed with it.
  if q.status = 'accepted' then
    raise exception 'This quote was accepted, so a job and a booking fee depend on it. Cancel the job first if it is not going ahead.';
  end if;

  -- Already closed is not an error. Two taps on a phone should not produce a
  -- red box, and the row is already in the state the person wanted.
  if q.status = 'closed' then
    return query select q.id, q.status, q.closed_at;
    return;
  end if;

  select p.id into actor from public.profiles p where p.id = auth.uid();

  return query
  update public.quotes
     set status        = 'closed',
         closed_at     = now(),
         closed_by     = actor,
         closed_reason = nullif(btrim(p_reason), '')
   where id = p_quote_id
  returning id, status, closed_at;
end;
$$;

comment on function public.close_quote(uuid, text) is
  'Withdraw a quote that is no longer needed. Refuses an accepted quote.
   A closed quote cannot be accepted from its public link.';

-- Reopening, because closing is a judgement and judgements are wrong
-- sometimes. It goes back to where it was: viewed if the customer had opened
-- it, sent if they never did -- NOT always to sent, which would erase the
-- fact that they read it and claim the nudge clock should start again.
create or replace function public.reopen_quote(p_quote_id uuid)
returns table (
  out_quote_id uuid,
  out_status   text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
begin
  select * into q from public.quotes where id = p_quote_id for update;

  if not found then
    raise exception 'That quote no longer exists.';
  end if;

  if q.status <> 'closed' then
    raise exception 'That quote is not closed.';
  end if;

  return query
  update public.quotes
     set status        = case when q.viewed_at is not null then 'viewed' else 'sent' end,
         closed_at     = null,
         closed_by     = null,
         closed_reason = null
   where id = p_quote_id
  returning id, status;
end;
$$;

revoke all on function public.close_quote(uuid, text) from public;
revoke all on function public.reopen_quote(uuid) from public;
grant execute on function public.close_quote(uuid, text) to authenticated;
grant execute on function public.reopen_quote(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Accepting, with one more refusal
-- ---------------------------------------------------------------------------
--
-- Reproduced in full because CREATE OR REPLACE needs the whole body. Only
-- the 'closed' guard differs from db/quotes.sql; this file is generated from
-- that one so the other guards cannot drift.
--
-- NOT dropped first: the signature is unchanged, so CREATE OR REPLACE
-- genuinely replaces rather than overloading. (Contrast
-- record_invoice_on_job in db/invoice-truth.sql, which gained an argument
-- and therefore had to be dropped by name.)

"""

FOOTER = """

grant execute on function public.sb_accept_quote(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. What does NOT need changing, and why
-- ---------------------------------------------------------------------------
--
-- sms_due_quote_nudges() filters `q.status in ('sent', 'viewed')` -- an
-- allowlist, not a denylist -- so a closed quote stops being chased without
-- this file touching it. That is the whole argument for allowlists: the
-- behaviour that is correct for a state nobody had thought of yet is the
-- behaviour you get for free.
--
-- sb_quote_public() already returns `status`, so 'closed' reaches the
-- customer's page without a signature change. Its sent -> viewed promotion
-- is guarded on `status = 'sent'`, so opening a closed link cannot walk it
-- backwards into viewed.
"""

out = HEADER + fn_new + FOOTER
open("db/quote-close.sql", "w", encoding="utf-8").write(out)
print(f"wrote db/quote-close.sql, {len(out)} chars")
