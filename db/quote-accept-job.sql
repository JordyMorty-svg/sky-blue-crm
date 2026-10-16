-- db/quote-accept-job.sql
--
-- An accepted quote becomes a job you can actually see.
--
-- Run after db/quotes.sql, db/quote-close.sql and db/quote-property.sql.
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT HAPPENED
-- ---------------------------------------------------------------------------
--
-- Vicki Guenther accepted a $1,195 quote for windows and gutters at a second
-- address on 14 October. Nothing appeared anywhere. Jordan only found out
-- because he happened to open her Quotes tab, and the first thing the CRM
-- told him when he got there was a lie: "a job and a booking fee depend on
-- it" — there was no job.
--
-- The cause is an asymmetry nobody designed on purpose:
--
--   * A quote raised against a LEAD, when accepted, moves that lead to
--     'booked'. The lead is now sitting on the board as a to-do, somebody
--     presses Schedule, and scheduleJob() makes the job.
--
--   * A quote raised against a CUSTOMER has no lead to move. sb_accept_quote
--     recorded the acceptance and stopped, with a comment saying "repeat
--     work goes straight to scheduling" — which was the intention and is not
--     a mechanism. Nothing told anybody to go and schedule it.
--
-- So the acceptance of repeat work — the most valuable kind, from somebody
-- who has already paid once — landed in the one place in the CRM nobody has
-- a reason to open.
--
-- db/quote-property.sql already anticipated the fix in its own header:
--
--     "Accepting a quote should book the job at the building that was
--      quoted. quotes.closed_job_id already ties the two together; without
--      property_id the job has to guess, and it would guess the primary --
--      which for the customer who prompted all of this is the wrong house."
--
-- The pointer was added. The booking was never built. This builds it.
--
-- ---------------------------------------------------------------------------
-- WHY 'upcoming' AND NOT 'scheduled'
-- ---------------------------------------------------------------------------
--
-- Because nobody has agreed a date. 'upcoming' already means exactly that in
-- this schema — jobService.js:516 calls it "due, not booked" — and there is
-- already a screen for turning one into a real booking (ConfirmVisit, at
-- /jobs/visit/:id, reached from the To schedule tab).
--
-- Inventing a new status, or a new queue, would have meant a new surface for
-- somebody to not look at. The whole fault here was work living somewhere
-- with no queue.

-- ---------------------------------------------------------------------------
-- 1. Which quote a job came from
-- ---------------------------------------------------------------------------
--
-- quotes.closed_job_id already points the other way, and is kept in step
-- below. This direction exists because the Jobs board has the job in hand
-- and needs to know, without a second query, whether it is looking at a
-- recurring visit or at accepted quote work — those want different words on
-- the card, and labelling a one-off "Recurring · visit 1" is the kind of
-- small lie that teaches people to stop reading the screen.

alter table public.jobs
  add column if not exists from_quote_id uuid
    references public.quotes (id) on delete set null;

comment on column public.jobs.from_quote_id is
  'The accepted quote this job was created from, when it was created by
   sb_accept_quote() rather than by somebody pressing Schedule. Null for
   every job booked by hand, and for every job that predates
   db/quote-accept-job.sql.';

create index if not exists jobs_from_quote_idx
  on public.jobs (from_quote_id)
  where from_quote_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Accepting a quote
-- ---------------------------------------------------------------------------
--
-- Everything above the customer branch is unchanged from db/quote-close.sql
-- and is reproduced rather than referenced, because `create or replace`
-- replaces the whole body and a function defined in two files is a function
-- nobody can read.

create or replace function public.sb_accept_quote(p_token text)
returns table (ok boolean, reason text, already boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  q       public.quotes%rowtype;
  new_job uuid;
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

  if q.lead_id is not null then
    -- A quote against a lead moves it to Booked, which is what fires the
    -- booking commission through the existing lead_events trigger, and puts
    -- the lead on the board where somebody will schedule it.
    update public.leads
       set status = 'booked',
           -- The accepted amount IS the price now. Leaving a stale estimate
           -- would have the commission calculate against a number the
           -- customer never agreed to.
           estimate = q.amount
     where id = q.lead_id
       and status not in ('booked', 'scheduled', 'completed');

  elsif q.customer_id is not null and q.closed_job_id is null then
    -- Repeat work. No lead exists to carry it onto a board, so the job is
    -- made here and lands in To schedule as a due visit with no date.
    --
    -- THE PROPERTY COMES FROM THE QUOTE, which is the entire reason
    -- quotes.property_id exists. Vicki's second address is not her primary
    -- one, and a job that guessed would have sent the van to the wrong
    -- house. The snapshotted address rides along for the same reason it is
    -- snapshotted on the quote: it is what the customer was shown.
    --
    -- Deliberately NOT set: starts_at (nobody has agreed one — that is what
    -- makes this 'upcoming'), and duration_hours (the scheduling screen
    -- derives a suggestion from the price; see src/services/durationService.js).
    insert into public.jobs (
      customer_id, from_quote_id, status,
      price, service_keys, property_id, address,
      service_plan, visit_number
    )
    values (
      q.customer_id, q.id, 'scheduled',
      q.amount, coalesce(q.service_keys, '{}'), q.property_id, q.address,
      'one_time', 1
    )
    returning id into new_job;

    -- Both directions, in one transaction. closed_job_id is what
    -- delete_quote() reads to refuse deleting the record of priced work,
    -- and from_quote_id is what the Jobs board reads to label the card.
    update public.quotes set closed_job_id = new_job where id = q.id;
  end if;

  return query select true, 'accepted', false;
end;
$$;

grant execute on function public.sb_accept_quote(text) to anon, authenticated;

comment on function public.sb_accept_quote(text) is
  'Accept a quote by its public token. A lead-backed quote moves the lead to
   booked; a customer-backed quote creates an upcoming job at the quoted
   property so the work appears in To schedule. Idempotent: a second
   acceptance returns already = true and creates nothing.';

-- ---------------------------------------------------------------------------
-- 3. Telling the truth about why a quote cannot be deleted
-- ---------------------------------------------------------------------------
--
-- The old refusal said "it has a job and a booking fee attached" for EVERY
-- accepted quote. For Vicki's it was wrong on both counts, and being told a
-- job existed is what sent Jordan looking for one. A message that asserts
-- things it has not checked is worse than a message that says less.
--
-- The refusal itself does not change -- an accepted quote is the record of
-- what somebody agreed to pay, and that is reason enough on its own.

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
    if q.closed_job_id is not null then
      raise exception
        'That quote was accepted and a job was created from it. Cancel the '
        'job first if the work is not going ahead.';
    else
      raise exception
        'That quote was accepted, so it is the record of what the customer '
        'agreed to pay. Close it instead if the work is not going ahead.';
    end if;
  end if;

  if q.closed_job_id is not null then
    raise exception
      'This quote is attached to a job, so it is the record of what that '
      'work was quoted at. Unlink the job first if you really need to '
      'delete it.';
  end if;

  -- The texts about it are kept and unlinked, not deleted. quote_id is
  -- `on delete set null` for the same reason the lead link is: the record
  -- that this number was texted has to survive the tidying up, or the
  -- opt-out and complaint history goes with it.
  delete from public.quotes where id = p_id;
  return true;
end;
$$;

grant execute on function public.delete_quote(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. What is already out there
-- ---------------------------------------------------------------------------
--
-- READ ONLY. Accepted customer quotes with no job are the ones this file was
-- written for and the ones it CANNOT retroactively fix: creating jobs for
-- them here would be a migration quietly booking work. They are printed so
-- somebody can look at each one and decide.

do $$
declare
  n int;
  r record;
begin
  select count(*) into n
    from public.quotes
   where status = 'accepted'
     and lead_id is null
     and customer_id is not null
     and closed_job_id is null;

  if n = 0 then
    raise notice 'No accepted customer quotes are missing a job.';
  else
    raise notice 'ACCEPTED WITH NO JOB (schedule these by hand): %', n;
    for r in
      select q.customer_name, q.amount, q.accepted_at, q.address
        from public.quotes q
       where q.status = 'accepted'
         and q.lead_id is null
         and q.customer_id is not null
         and q.closed_job_id is null
       order by q.accepted_at desc
    loop
      raise notice '  % — $% accepted % at %',
        r.customer_name, r.amount, r.accepted_at::date,
        coalesce(r.address, 'no address on the quote');
    end loop;
  end if;
end $$;
