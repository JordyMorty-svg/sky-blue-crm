-- Sky Blue CRM — the automatic text when a lead moves along the board
--
-- Run once in the Supabase SQL editor, AFTER db/sms.sql, db/sms-delivery.sql
-- and db/lead-ack.sql. Safe to re-run. Plain SQL: no psql meta-commands.
--
-- WHAT THIS DOES
-- --------------
-- Fifteen minutes after a lead is moved to contacted, quoted or booked, they
-- get one text about it:
--
--   contacted  we have your details, ask us anything or set up an estimate
--   quoted     here is the price we have you down for, does it work
--   booked     you are booked in for <day> at <time>
--
-- READ THIS BEFORE CHANGING ANYTHING HERE
-- ---------------------------------------
-- This runs ONCE A MINUTE, off the same sweep as the website acknowledgment.
-- Every guard below is load-bearing in a way it would not be on a nightly
-- job, because the cost of getting one wrong is not "a duplicate text", it is
-- a text every sixty seconds until somebody notices.
--
-- Four guards, and each one exists because of a specific way this could go
-- wrong on a driveway:
--
--   1. NO BACKFILL. Only events after sb_lead_nudge_go_live(). Without it the
--      first run texts every lead sitting in contacted, quoted or booked —
--      dozens of people, some moved weeks ago, all at once.
--
--   2. ONLY THE LATEST STATUS SENDS. Quoting at the door means a lead can go
--      contacted -> quoted -> booked inside one visit. Each move queues its
--      own nudge, and without this they would get three texts in forty-five
--      minutes while you are still standing there. The sweep sends only the
--      message that is still true when it runs.
--
--   3. A QUIET PERIOD AFTER ANY OUTBOUND TEXT. A website lead already gets
--      "thanks for reaching out" a minute after they submit. Moving them to
--      contacted ten minutes later would put a second, near-identical text on
--      their phone half an hour after the first.
--
--   4. STALENESS. A nudge that could not send — quiet hours, Quo down —
--      expires rather than queueing. "You're booked in for tomorrow at 9"
--      arriving two days later is worse than silence.
--
-- Asserted by verify/lead-nudges.sql and verify/lead-nudges.mjs, both
-- mutation-tested.

-- ---------------------------------------------------------------------------
-- 0. Dependencies
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.claim_sms(text,text,text,uuid,uuid,uuid,uuid,uuid,boolean)') is null then
    raise exception
      'Run db/sms.sql, db/sms-delivery.sql and db/lead-ack.sql before this file.';
  end if;
  if to_regclass('public.lead_events') is null then
    raise exception 'Run db/lead-events.sql before this file — the nudges read its history.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The knobs
-- ---------------------------------------------------------------------------

-- Long enough that it does not read as a machine reacting to a click, short
-- enough that it lands while the conversation at the door is still fresh.
create or replace function public.sb_lead_nudge_delay()
returns interval language sql immutable as $$ select interval '15 minutes' $$;

-- No automatic nudge if ANY outbound text already went to this lead inside
-- this window.
--
-- This is the guard that stops the website acknowledgment and the contacted
-- nudge landing together. It also quietly covers a second case: a lead moved
-- twice in an afternoon gets one text, not two.
--
-- THE TRADE-OFF, because somebody will want to change this. At four hours, a
-- lead who enquires on the website and is quoted the same visit gets the
-- acknowledgment and NOT the quoted nudge — the more useful of the two. Drop
-- this to an hour and the quote price gets through. Raise it and the CRM goes
-- quieter. It is a knob so that judgement can be revised without a migration.
create or replace function public.sb_lead_nudge_quiet()
returns interval language sql immutable as $$ select interval '4 hours' $$;

-- Past this, the moment has gone. A nudge held overnight by quiet hours still
-- sends in the morning; one held for two days does not.
create or replace function public.sb_lead_nudge_stale()
returns interval language sql immutable as $$ select interval '24 hours' $$;

-- NOTHING BEFORE THIS IS EVER TEXTED.
--
-- Compared against lead_events.created_at, so every move older than it is
-- silently ignored. This is the entire no-backfill guarantee, and it is the
-- one thing standing between running this file and texting every lead already
-- sitting in contacted, quoted and booked.
--
-- STAMPED WITH THE MOMENT YOU RAN THE FILE, not with a date written into it.
-- sb_commission_go_live() uses a hardcoded literal and carries a comment
-- telling you to change it if you run the file later than you meant to. That
-- works until nobody reads the comment. The failure here is worse than a
-- missed commission: a date set to midnight means every lead moved earlier
-- THAT DAY is still in scope, so running this over lunch texts everyone the
-- morning touched. Writing now() into the function closes that window to
-- zero.
--
-- Created, never replaced. Re-running the file must not push the line
-- forward — that would suppress nudges legitimately waiting in the fifteen
-- minute window.
do $$
begin
  if to_regprocedure('public.sb_lead_nudge_go_live()') is null then
    execute format(
      'create function public.sb_lead_nudge_go_live() returns timestamptz '
      'language sql immutable as $f$ select %L::timestamptz $f$',
      now()
    );
    raise notice
      'Board nudges go live from %. Nothing moved before that is ever texted.',
      now();
  else
    raise notice
      'Go-live was already set to %; leaving it alone.',
      public.sb_lead_nudge_go_live();
  end if;
end $$;

comment on function public.sb_lead_nudge_go_live() is
  'Lead moves before this are never texted about. Stamped with the moment
   db/lead-nudges.sql was first run, so the first sweep cannot reach back to
   anything already on the board.';

-- ---------------------------------------------------------------------------
-- 2. The dedupe key stops being a generated expression
-- ---------------------------------------------------------------------------
--
-- THIS IS THE FOURTH TIME sms_messages.dedupe_key has been dropped and
-- rebuilt: db/sms.sql wrote it, db/lead-ack.sql added 'ack',
-- db/follow-ups.sql added 'review', and three more kinds arrive here.
--
-- Each rebuild means retyping every existing case, and leaving one out breaks
-- a feature nobody was changing — quotes would start sending twice and the
-- review request would not be why. db/lead-ack.sql also had to put the unique
-- index back and restored the wrong predicate, which made ON CONFLICT match
-- no index at all, so EVERY text the CRM sent failed until it was caught.
--
-- So the expression moves into a function. The column calls it; adding a kind
-- later is `create or replace function` and nothing else. No drop, no index to
-- restore, no case to forget.
--
-- THE ONE CAVEAT, stated because it is not obvious: a stored generated column
-- is NOT recomputed when the function changes. Rows written before the change
-- keep the key they were given. That is fine for ADDING a kind, since no
-- existing row has it. It is not fine for changing the format of a key that
-- is already in use — doing that needs a real rebuild, and this comment is
-- where you should stop and think about it.

create or replace function public.sb_sms_dedupe_key(
  p_kind     text,
  p_lead_id  uuid,
  p_quote_id uuid,
  p_job_id   uuid
)
returns text
language sql
immutable
as $$
  select case
    -- Null for anything hand-written. A person typing a second text to the
    -- same customer is not a bug, and never has been.
    when p_quote_id is not null
     and p_kind in ('quote', 'nudge_sent', 'nudge_viewed')
      then p_kind || ':q:' || p_quote_id::text

    when p_job_id is not null and p_kind = 'reminder'
      then 'reminder:j:' || p_job_id::text

    -- One review request per job, forever. Keyed on the job, not the
    -- customer: somebody who has us back next spring is askable again, and
    -- the twelve-month quiet period is what decides that.
    when p_job_id is not null and p_kind = 'review'
      then 'review:j:' || p_job_id::text

    -- One acknowledgment per lead, forever. Not per day, not per enquiry:
    -- somebody who fills the form in twice has not asked to be told twice
    -- that we got it.
    when p_lead_id is not null and p_kind = 'ack'
      then 'ack:l:' || p_lead_id::text

    -- One of each nudge per lead, forever. A lead that goes
    -- contacted -> lost -> contacted again does not get a second "we have
    -- your details"; they have heard it.
    --
    -- ONE branch for all three kinds rather than three branches. A fourth
    -- stage added later needs its name in this list and nothing else.
    when p_lead_id is not null
     and p_kind in ('nudge_contacted', 'nudge_quoted', 'nudge_booked')
      then p_kind || ':l:' || p_lead_id::text

    else null
  end
$$;

comment on function public.sb_sms_dedupe_key(text, uuid, uuid, uuid) is
  'The double-send guard for sms_messages, as a function so the column that
   uses it never has to be rebuilt again. Adding a kind here is the whole
   change. Note that existing rows keep the key they were stored with.';

do $$
begin
  -- Only rebuild if the column is not already calling the function. Re-running
  -- the file otherwise takes an ACCESS EXCLUSIVE lock to change nothing.
  if exists (
    select 1 from pg_attrdef d
    join pg_class c on c.oid = d.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sms_messages'
      and pg_get_expr(d.adbin, d.adrelid) like '%sb_sms_dedupe_key%'
  ) then
    raise notice 'dedupe_key already calls sb_sms_dedupe_key(); nothing to do.';
    return;
  end if;

  drop index if exists public.sms_messages_dedupe_idx;
  alter table public.sms_messages drop column if exists dedupe_key;

  alter table public.sms_messages
    add column dedupe_key text generated always as (
      public.sb_sms_dedupe_key(kind, lead_id, quote_id, job_id)
    ) stored;

  raise notice 'dedupe_key now calls sb_sms_dedupe_key(). This is the last rebuild.';
end $$;

-- THE PREDICATE MUST MATCH claim_sms()'s ON CONFLICT CLAUSE EXACTLY.
--
-- Three statuses, not two. db/sms.sql created this index over
-- ('queued', 'sent'); db/sms-delivery.sql widened it to include 'undelivered'
-- and widened claim_sms to match. Dropping the column above takes the index
-- with it, so it has to go back the WIDE way. db/lead-ack.sql put back the
-- two-status version once and the result was not subtle drift: ON CONFLICT
-- with no matching index raises outright, so every text the CRM tried to send
-- failed, quotes included.
drop index if exists public.sms_messages_dedupe_idx;
create unique index sms_messages_dedupe_idx
  on public.sms_messages (dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'sent', 'undelivered');

-- ---------------------------------------------------------------------------
-- 3. Which leads are owed a nudge
-- ---------------------------------------------------------------------------

create or replace function public.sms_due_lead_nudges(p_limit int default 25)
returns table (
  out_lead_id    uuid,
  out_kind       text,
  out_name       text,
  out_phone      text,
  out_service    text,
  out_estimate   numeric,
  out_appoint_at timestamptz,
  out_sender     text
)
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    -- The most recent move per lead, and only that one. This is guard 2:
    -- contacted -> quoted ten minutes later means the contacted row never
    -- appears here at all, so only the message that is still true can send.
    select distinct on (e.lead_id)
           e.lead_id, e.to_status, e.created_at, e.changed_by
    from public.lead_events e
    where e.to_status in ('contacted', 'quoted', 'booked')
      and e.created_at >= public.sb_lead_nudge_go_live()
    order by e.lead_id, e.created_at desc, e.id desc
  )
  select
    l.id,
    'nudge_' || x.to_status,
    l.name,
    public.sb_sms_e164(l.phone),
    l.service,
    l.estimate,
    l.appointment_at,
    p.full_name
  from latest x
  join public.leads l on l.id = x.lead_id
  left join public.profiles p on p.id = x.changed_by
  where
    -- The timer, and the expiry on the other side of it.
    x.created_at <= now() - public.sb_lead_nudge_delay()
    and x.created_at >= now() - public.sb_lead_nudge_stale()

    -- The lead is still where the event said it was. Belt and braces with
    -- `latest` above: that picks the newest EVENT, this catches a status
    -- changed by something that writes leads.status without an event.
    and l.status = x.to_status

    -- Something to text.
    and public.sb_sms_e164(l.phone) is not null
    and not public.sb_sms_opted_out(l.phone)

    -- Guard 3: nothing automatic on top of a recent conversation. Counts
    -- MANUAL texts too, deliberately — if somebody has just typed this
    -- customer a real message, a robot following it up is worse than nothing.
    and not exists (
      select 1 from public.sms_messages m
      where m.lead_id = l.id
        and m.direction = 'out'
        and m.created_at >= now() - public.sb_lead_nudge_quiet()
    )

    -- Never twice. The dedupe index enforces this at write time; saying it
    -- here as well keeps the sweep from claiming rows it cannot send, which
    -- would otherwise burn the whole p_limit on the same few leads.
    and not exists (
      select 1 from public.sms_messages m
      where m.lead_id = l.id
        and m.kind = 'nudge_' || x.to_status
        and m.status in ('queued', 'sent', 'undelivered')
    )

    -- QUOTED ONLY: skip it if a real quote has already gone out from the CRM.
    -- That text carries the price AND a link they can accept on; this one is
    -- a plain-text approximation of it. Sending both makes the business look
    -- like it does not know what it has already said.
    --
    -- Tested on sent_at rather than on status. Status would mean listing
    -- which of draft/sent/viewed/accepted/declined/closed count as "gone
    -- out", and getting that list wrong the day a new status appears. A
    -- sent_at timestamp means it left the building, whatever happened after.
    and (
      x.to_status <> 'quoted'
      or not exists (
        select 1 from public.quotes q
        where q.lead_id = l.id and q.sent_at is not null
      )
    )

    -- BOOKED ONLY: there has to be an appointment to confirm. Booking a lead
    -- without a time is a normal thing to do mid-call, and "you're booked in
    -- for null" is not a text anybody should receive.
    and (x.to_status <> 'booked' or l.appointment_at is not null)

  order by x.created_at
  limit greatest(p_limit, 0);
$$;

comment on function public.sms_due_lead_nudges(int) is
  'Leads whose last move was 15+ minutes ago and who are owed one text about
   it. Applies every suppression rule at READ time, so the sweep that calls
   it holds no policy of its own.';

grant execute on function public.sms_due_lead_nudges(int) to service_role;
grant execute on function public.sb_sms_dedupe_key(text, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. What is waiting right now
-- ---------------------------------------------------------------------------

select out_kind, count(*) as due
from public.sms_due_lead_nudges(500)
group by out_kind
order by out_kind;
