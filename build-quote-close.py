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
-- 1. The status, the outcome, and who closed it
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
  add column if not exists closed_reason text,
  add column if not exists closed_job_id uuid references public.jobs (id) on delete set null,
  add column if not exists closed_note   text;

-- WHY THE REASON IS A CODE AND NOT A SENTENCE.
--
-- "Closed" on its own throws away the only interesting thing about a quote
-- that ended. Jeff Krueger's $1,800 pressure wash was DONE -- it got folded
-- into the $3,280 job -- and recording that the same way as "they never
-- replied" would count a win as a loss every time anyone looks at a
-- conversion rate.
--
-- Four codes, because four is what actually happens:
--
--   done_elsewhere  the work happened, billed on another job     WIN
--   requoted        superseded by a corrected quote              neither
--   no_response     sent, chased, silence                        loss
--   went_elsewhere  they engaged and said no                     loss
--
-- requoted is deliberately neither. Nobody turned anything down; we got the
-- number wrong and sent another. Counting it as a loss would make a
-- correction look like a rejection.
alter table public.quotes drop constraint if exists quotes_closed_reason_check;

alter table public.quotes
  add constraint quotes_closed_reason_check
  check (
    closed_reason is null
    or closed_reason in ('done_elsewhere', 'requoted', 'no_response', 'went_elsewhere')
  );

comment on column public.quotes.closed_reason is
  'Why this quote ended. done_elsewhere | requoted | no_response |
   went_elsewhere. Null for a quote that is not closed.';
comment on column public.quotes.closed_job_id is
  'The job the work was actually done on, when closed as done_elsewhere.';

-- ---------------------------------------------------------------------------
-- 2. Which endings are final
-- ---------------------------------------------------------------------------
--
-- A quote that ended because SOMETHING ELSE NOW EXISTS -- the work was done,
-- or a replacement quote was sent -- is finished, the way an accepted quote
-- is finished. Reopening it would either duplicate a job that already
-- happened or put two live quotes in front of the same customer.
--
-- A quote that ended because the customer simply did not act is a different
-- thing. They might ring in March. That one reopens.
--
-- A function rather than a list in the app, so the database and three
-- screens cannot come to disagree about which quotes are finished.
create or replace function public.sb_quote_ending_is_final(p_reason text)
returns boolean
language sql
immutable
as $$ select coalesce(p_reason, '') in ('done_elsewhere', 'requoted') $$;

-- ---------------------------------------------------------------------------
-- 3. Closing and reopening
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER rather than widening the RLS update policy, which allows
-- staff to write only draft / sent / declined. Going through a function
-- keeps that policy narrow AND puts the accepted-quote refusal in one place
-- where it can be given a sentence somebody can act on.
-- DROPPED first. An earlier run of this file created close_quote(uuid, text);
-- the signature is now four arguments. CREATE OR REPLACE with a different
-- argument list does not replace, it OVERLOADS -- leaving two functions of
-- the same name for PostgREST to choose between, which it does by guessing.
-- Exactly the trap record_invoice_on_job hit in db/invoice-truth.sql.
drop function if exists public.close_quote(uuid, text);

create or replace function public.close_quote(
  p_quote_id uuid,
  p_reason   text,
  p_job_id   uuid default null,
  p_note     text default null
)
returns table (
  out_quote_id uuid,
  out_status   text,
  out_reason   text,
  out_final    boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
  actor uuid;
  job_ok boolean;
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

  if coalesce(p_reason, '') not in
     ('done_elsewhere', 'requoted', 'no_response', 'went_elsewhere') then
    raise exception 'Pick a reason for closing this quote.';
  end if;

  -- Already closed is not an error, but the reason may be being corrected,
  -- so this falls through rather than returning early. Closing twice with
  -- the same reason is a no-op either way.

  -- A job may only be attached to the ending that means one. Letting
  -- "never heard back" carry a job id would produce rows that say the work
  -- was done and not done at once.
  if p_job_id is not null then
    if p_reason <> 'done_elsewhere' then
      raise exception 'A job can only be linked when the work was done on another job.';
    end if;

    -- And it has to be THIS customer's job. A mistyped pick pointing at
    -- somebody else's work is worse than no link: it reads as a fact.
    select exists (
      select 1 from public.jobs j
      where j.id = p_job_id
        and (
          (q.lead_id is not null and j.lead_id = q.lead_id)
          or (q.customer_id is not null and j.customer_id = q.customer_id)
          or (j.lead_id is not null and j.lead_id = q.lead_id)
        )
    ) into job_ok;

    if not job_ok then
      raise exception 'That job belongs to a different customer.';
    end if;
  end if;

  select p.id into actor from public.profiles p where p.id = auth.uid();

  return query
  update public.quotes
     set status        = 'closed',
         closed_at     = coalesce(closed_at, now()),
         closed_by     = actor,
         closed_reason = p_reason,
         closed_job_id = case when p_reason = 'done_elsewhere' then p_job_id else null end,
         closed_note   = nullif(btrim(p_note), '')
   where id = p_quote_id
  returning id, status, closed_reason, public.sb_quote_ending_is_final(closed_reason);
end;
$$;

comment on function public.close_quote(uuid, text, uuid, text) is
  'End a quote that will not be accepted, recording WHY. Refuses an accepted
   quote. A closed quote cannot be accepted from its public link.';

-- Reopening, because a quote that merely went quiet might not have.
--
-- Refused for the endings that are final: the work was done, or a
-- replacement quote exists. Those are finished the way an accepted quote is
-- finished, and reopening one would duplicate something that already
-- happened.
--
-- It goes back to where it was: viewed if the customer had opened it, sent
-- if they never did -- NOT always to sent, which would erase the fact that
-- they read it and claim the nudge clock should start again.
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

  if public.sb_quote_ending_is_final(q.closed_reason) then
    raise exception 'This quote was settled by something else — the work was done, or it was re-quoted. Send a new quote instead of reopening this one.';
  end if;

  return query
  update public.quotes
     set status        = case when q.viewed_at is not null then 'viewed' else 'sent' end,
         closed_at     = null,
         closed_by     = null,
         closed_reason = null,
         closed_job_id = null,
         closed_note   = null
   where id = p_quote_id
  returning id, status;
end;
$$;

revoke all on function public.close_quote(uuid, text, uuid, text) from public;
revoke all on function public.reopen_quote(uuid) from public;
grant execute on function public.close_quote(uuid, text, uuid, text) to authenticated;
grant execute on function public.reopen_quote(uuid) to authenticated;
grant execute on function public.sb_quote_ending_is_final(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Accepting, with one more refusal
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
