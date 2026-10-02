-- Sky Blue CRM — automatic review requests after a completed job
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Three days after a job is completed, the customer gets one message:
-- thanks, what we did, a review link, and an easy way to tell us if
-- something was wrong. Sent by netlify/functions/send-follow-ups.mjs, which
-- runs once a day on a schedule.
--
-- BY EMAIL, OR BY TEXT WHEN THERE IS NO EMAIL ADDRESS.
--
-- Plenty of customers are a phone number and nothing else — a job booked
-- over the phone, a door knock, a neighbour who waved the van down. Those
-- people were simply never asked for a review, which is a quiet way to lose
-- most of the reviews the business is owed. The channel is decided at SEND
-- time by sb_follow_up_channel(), three days after the job, so an address
-- typed in on day two still wins the email it should.
--
-- Email is preferred when both exist. It is longer, it carries the
-- unsubscribe link CAN-SPAM requires, and it costs nothing to send.
--
-- THIS FILE IS EDITED IN PLACE RATHER THAN SUPERSEDED BY A SECOND MIGRATION.
-- Adding the SMS route means changing claim_follow_ups() and three functions
-- around it, and a later file redefining them would leave two versions of
-- each in the repo with only the run order deciding which one is real. Next
-- time somebody reads this file to find out what the queue does, they would
-- be reading the wrong one. So: re-run this, and section 0b drops the old
-- signatures first.
--
-- THE WHOLE POINT OF THIS FILE is that it is impossible to email the same
-- person twice for the same job, and hard to email anyone by accident.
-- These are real customers; a bug here doesn't throw an exception, it sends
-- Mrs. Whoever four emails about a window clean and there is no undo. So
-- the safety lives in the database, not in the sending code:
--
--   * one row per job, enforced by a unique constraint
--   * rows are CLAIMED before sending, so two overlapping runs can't both
--     pick up the same one
--   * every suppression rule is re-checked at SEND time, not queue time,
--     because three days is long enough for the job to be cancelled, the
--     customer to opt out, or an email address to appear
--   * anything that missed its window is closed out rather than left
--     pending, so a function that was broken for a fortnight can't come
--     back up and blast a backlog

-- ---------------------------------------------------------------------------
-- 0a. What this needs to be run first
-- ---------------------------------------------------------------------------

-- The text route borrows the SMS plumbing wholesale: E.164 normalisation,
-- the opt-out list, quiet hours, the outbox and its double-send index. None
-- of that is reimplemented here.
--
-- Checked rather than assumed, because the failure is otherwise invisible in
-- the worst way: every function below would still be created, the daily run
-- would claim rows marked channel 'sms', and claim_sms would not exist to
-- send them.
do $$
begin
  if to_regprocedure('public.sb_sms_e164(text)') is null
     or to_regprocedure('public.sb_sms_opted_out(text)') is null then
    raise exception
      'Run db/sms.sql and db/sms-delivery.sql before this file. The review '
      'request can now go out as a text when a customer has no email '
      'address, and it uses the SMS tables to do it.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0b. Upgrading from the email-only version
-- ---------------------------------------------------------------------------

-- CREATE OR REPLACE cannot change a function's return type or argument list.
-- A changed RETURNS TABLE is a hard error; a changed argument list is worse,
-- because it silently creates an OVERLOAD and PostgREST then picks between
-- them by guessing. Both of those have bitten this codebase before, so the
-- old signatures go first, by name and exact arguments.
--
-- Dropping and recreating a function is not destructive: no row in
-- follow_ups is touched, and anything queued stays queued.
drop function if exists public.claim_follow_ups(int);
drop function if exists public.claim_manual_follow_up(uuid);
drop function if exists public.preview_follow_ups(int);
drop function if exists public.mark_follow_up_sent(bigint, text, text);

-- ---------------------------------------------------------------------------
-- 0. The knobs
-- ---------------------------------------------------------------------------

-- Functions rather than a settings table: they inline into the queries
-- below, they're one line to change, and there's no row to forget to seed.

-- How long after completion to wait. The email should land after the
-- windows have had a few days of weather, not while the van is still on
-- the drive.
create or replace function public.sb_follow_up_delay_days()
returns int language sql immutable as $$ select 3 $$;

-- How long a queued follow-up stays valid. Past this it is closed out
-- unsent. This is the blast guard: if the scheduler is broken for a month,
-- the fix must not mail everyone whose job was completed in that month.
create or replace function public.sb_follow_up_window_days()
returns int language sql immutable as $$ select 14 $$;

-- How long to leave a customer alone after asking them for a review.
-- Twelve months, so a quarterly customer is asked once a year rather than
-- four times. Set this to 0 to ask after every single job.
create or replace function public.sb_follow_up_quiet_months()
returns int language sql immutable as $$ select 12 $$;

-- Oregon, not UTC. Redeclared here (it also lives in db/job-events.sql) so
-- this file stands on its own whichever order the two are run in.
create or replace function public.sb_local(ts timestamptz)
returns timestamp language sql immutable
as $$ select ts at time zone 'America/Los_Angeles' $$;

-- When the email for a job completed at `completed` should go out.
--
-- Midnight local on the third day, NOT completed_at + 72 hours. A job
-- submitted at 8pm Monday would otherwise come due at 8pm Thursday, miss
-- that morning's run, and go out Friday — four days, not three. Anchoring
-- to the start of the day means "completed Monday, emailed Thursday" holds
-- no matter what time the crew finished.
create or replace function public.sb_follow_up_due(completed timestamptz)
returns timestamptz language sql stable as $$
  select (((completed at time zone 'America/Los_Angeles')::date
           + public.sb_follow_up_delay_days())::timestamp)
         at time zone 'America/Los_Angeles'
$$;

-- ---------------------------------------------------------------------------
-- 1. Who not to email
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists email_opt_out          boolean not null default false,
  add column if not exists last_review_request_at timestamptz;

comment on column public.customers.email_opt_out is
  'Set when someone asks not to be emailed. Checked at send time, so
   ticking it stops a follow-up that is already queued.';
comment on column public.customers.last_review_request_at is
  'When we last asked this customer for a review. Drives the quiet period
   in sb_follow_up_quiet_months() — this is what stops a recurring customer
   being asked after every visit.';

-- They already left one. Ticked by hand on the customer profile, because
-- nothing can work this out reliably: Google's Business Profile API returns
-- a reviewer's DISPLAY NAME and nothing else — no email, no phone — so
-- matching "Dana W." to a customer record is guesswork, and a wrong guess
-- fails silently in the expensive direction (you stop asking someone who
-- never reviewed, and never find out).
--
-- DELIBERATELY NOT email_opt_out. An unsubscribe is a request from the
-- customer with legal weight behind it; this is a fact about the business.
-- Folding them together would mean that adding any second kind of email
-- later — an appointment reminder, say — would silently withhold it from
-- everyone who was kind enough to leave a review.
alter table public.customers
  add column if not exists reviewed_at timestamptz;

comment on column public.customers.reviewed_at is
  'When this customer left a Google review, as far as we know. Set by hand.
   Suppresses further review requests; does not affect any other email.';

-- ---------------------------------------------------------------------------
-- 1b. Which way to reach them
-- ---------------------------------------------------------------------------

-- 'email', 'sms', or null for "there is no way to ask this person".
--
-- ONE function, called from four places — the claim, the manual send, the
-- preview and the sweep's skip reason. They have to agree: a preview that
-- says "email" where the run sends a text is a preview of nothing, and a
-- sweep that writes "No email address on file" about somebody we just texted
-- is a lie in the record.
--
-- THE OPT-OUT BLOCKS BOTH ROUTES, and that is the one judgement call in
-- here worth arguing about.
--
-- email_opt_out is set by the unsubscribe link at the bottom of the review
-- email, which says "unsubscribe from follow-up emails". Read strictly, it
-- is about email. Read as the customer meant it, it is "stop asking me for
-- reviews" — and texting somebody who just clicked unsubscribe, because the
-- wording gave us a loophole, is the kind of thing that turns one annoyed
-- customer into a complaint. Receipts and appointment details are a
-- different question and are not affected by this column at all.
--
-- The sms_opt_outs list is the reverse case and blocks only the text: it is
-- a STOP reply, which legally and plainly means stop texting.
create or replace function public.sb_follow_up_channel(
  p_email        text,
  p_email_opt_out boolean,
  p_phone        text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when coalesce(p_email_opt_out, false) then null
    when nullif(btrim(coalesce(p_email, '')), '') is not null then 'email'
    when public.sb_sms_e164(p_phone) is not null
     and not public.sb_sms_opted_out(p_phone) then 'sms'
    else null
  end
$$;

comment on function public.sb_follow_up_channel(text, boolean, text) is
  'How to ask this customer for a review: email, sms, or null for no way at
   all. Email wins when both exist. An email opt-out blocks both routes.';

-- ---------------------------------------------------------------------------
-- 1c. One review text per job, forever
-- ---------------------------------------------------------------------------

-- sms_messages.dedupe_key is a GENERATED column, so teaching it about review
-- texts means dropping and re-adding the column, and the unique index with
-- it. Same surgery db/lead-ack.sql did for acknowledgments, and for the same
-- reason: sms_due_* queries are a query, this is a CONSTRAINT. Two runs
-- overlapping both see the row as unsent; the index is what lets exactly one
-- through.
--
-- Guarded on the review case being absent so re-running this file is free.
do $$
begin
  if to_regclass('public.sms_messages') is null then
    raise exception 'public.sms_messages is missing — run db/sms.sql first';
  end if;

  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sms_messages'
      and a.attname = 'dedupe_key' and not a.attisdropped
  ) and not exists (
    select 1 from pg_attrdef d
    join pg_class c on c.oid = d.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sms_messages'
      and pg_get_expr(d.adbin, d.adrelid) like '%review:j:%'
  ) then
    drop index if exists public.sms_messages_dedupe_idx;
    alter table public.sms_messages drop column dedupe_key;

    -- EVERY case, not just the new one. The column is being rebuilt from
    -- nothing, so anything left out here stops deduplicating silently —
    -- quotes would start going twice, not review texts.
    alter table public.sms_messages
      add column dedupe_key text generated always as (
        case
          when quote_id is not null
           and kind in ('quote', 'nudge_sent', 'nudge_viewed')
            then kind || ':q:' || quote_id::text
          when job_id is not null and kind = 'reminder'
            then 'reminder:j:' || job_id::text
          when lead_id is not null and kind = 'ack'
            then 'ack:l:' || lead_id::text
          -- Keyed on the JOB, matching follow_ups.job_id, which is unique.
          -- Not on the customer: a customer who has us back next spring
          -- should be askable again, and the twelve-month quiet period is
          -- what decides that, not this.
          when job_id is not null and kind = 'review'
            then 'review:j:' || job_id::text
          else null
        end
      ) stored;

    raise notice 'dedupe_key rebuilt with the review case.';
  else
    raise notice 'dedupe_key already knows about review texts; nothing to do.';
  end if;
end $$;

-- THE PREDICATE MUST MATCH claim_sms()'s ON CONFLICT CLAUSE EXACTLY.
--
-- Three statuses. db/sms.sql created this index over ('queued', 'sent');
-- db/sms-delivery.sql widened it to include 'undelivered' and widened
-- claim_sms to match. Dropping the column above takes the index with it, so
-- it has to go back the WIDE way. db/lead-ack.sql put back the two-status
-- version once and the result was not subtle drift: ON CONFLICT with no
-- matching index raises outright, so every text the CRM tried to send
-- failed — quotes included.
drop index if exists public.sms_messages_dedupe_idx;
create unique index sms_messages_dedupe_idx
  on public.sms_messages (dedupe_key)
  where dedupe_key is not null
    and status in ('queued', 'sent', 'undelivered');

-- ---------------------------------------------------------------------------
-- 2. The outbox
-- ---------------------------------------------------------------------------

create table if not exists public.follow_ups (
  id          bigint generated always as identity primary key,

  -- UNIQUE is the double-send guard, and it is the most important line in
  -- this file. Everything else is a policy that could be got wrong; this is
  -- a constraint the database will not let the app violate. Completing a
  -- job, un-completing it and completing it again still yields one row.
  job_id      uuid not null unique references public.jobs (id)      on delete cascade,
  customer_id uuid          references public.customers (id)        on delete cascade,

  -- 'review' today. Text so a "rebook nudge" or "winter reminder" can be
  -- added without a migration, the same way job_events.kind works.
  kind        text not null default 'review',

  due_at      timestamptz not null,

  -- pending  — queued, waiting for its due date
  -- sending  — claimed by a run that is mid-flight
  -- sent     — the provider accepted it
  -- skipped  — a rule said no (see note); terminal, never retried
  -- failed   — the provider rejected it; retried until attempts runs out
  status      text not null default 'pending',

  sent_at     timestamptz,
  sent_to     text,          -- the address as it was at send time
  provider_id text,          -- Resend's id, for looking a send up later
  attempts    int not null default 0,
  note        text,          -- why it was skipped, or the last error
  created_at  timestamptz not null default now()
);

-- The only query that matters: what is due right now.
create index if not exists follow_ups_pending_idx
  on public.follow_ups (due_at) where status = 'pending';
create index if not exists follow_ups_customer_idx
  on public.follow_ups (customer_id, created_at);

comment on table public.follow_ups is
  'One queued follow-up email per completed job. Written by a trigger,
   drained by netlify/functions/send-follow-ups.mjs. The unique job_id is
   what makes a double send impossible.';

alter table public.follow_ups enable row level security;

-- Readable so the job page can show "follow-up goes out Thursday", and the
-- customer page can show what has been sent. No insert/update policy:
-- everything is written by the security-definer functions below, so there
-- is exactly one code path that can mark something sent.
drop policy if exists "follow_ups readable by authenticated" on public.follow_ups;
create policy "follow_ups readable by authenticated"
  on public.follow_ups for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Queueing one when a job is completed
-- ---------------------------------------------------------------------------

-- ON UPDATE ONLY, and deliberately so.
--
-- customerService.addPastJobs() bulk-INSERTS historical jobs with
-- status = 'completed' — that is how the season's existing work got into
-- the CRM. If this trigger fired on insert, importing history would queue a
-- review request for every job Sky Blue has ever done. The window guard in
-- section 4 would catch it, but a constraint you rely on being caught later
-- is a bug waiting for someone to widen the window.
create or replace function public.queue_follow_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the moment of completion, not every save of an already-done job.
  if new.status is distinct from 'completed'
     or old.status is not distinct from 'completed' then
    return new;
  end if;

  -- Nobody to email. Jobs always carry a customer in practice; this is here
  -- so a hand-edited row can't blow up the completion itself.
  if new.customer_id is null then
    return new;
  end if;

  insert into public.follow_ups (job_id, customer_id, kind, due_at)
  values (
    new.id,
    new.customer_id,
    'review',
    public.sb_follow_up_due(coalesce(new.completed_at, now()))
  )
  -- Already queued, or already sent months ago. Either way, leave it alone.
  on conflict (job_id) do nothing;

  return new;
end;
$$;

drop trigger if exists jobs_queue_follow_up on public.jobs;

-- AFTER, so completed_at has already been stamped by jobs_stamp_completed
-- (a BEFORE trigger in db/job-events.sql) and sb_follow_up_due gets the
-- real completion moment rather than null.
create trigger jobs_queue_follow_up
  after update on public.jobs
  for each row
  execute function public.queue_follow_up();

-- No backfill, on purpose. Every job completed before this file was run
-- stays unqueued. Those customers had their windows cleaned weeks or months
-- ago and an email asking how it went would be strange at best.

-- ---------------------------------------------------------------------------
-- 4. Closing out the ones that missed their moment
-- ---------------------------------------------------------------------------

-- Run at the top of every send. Without this, suppressed rows sit as
-- 'pending' forever and eventually become due — a customer inside their
-- quiet period would be silently held for a year and then asked about a job
-- they've long forgotten.
create or replace function public.sweep_follow_ups()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  closed int;
begin
  -- A run that claimed rows and then died (deploy mid-flight, timeout)
  -- leaves them stuck in 'sending'. Give them back after an hour. Safe
  -- because a claim is taken before the send, so the worst case is a
  -- genuinely-sent email being retried once — and mark_follow_up_sent is
  -- idempotent, so even that resolves to one row.
  update public.follow_ups
  set status = 'pending'
  where status = 'sending'
    and created_at < now() - interval '1 hour'
    and sent_at is null;

  -- The note is the whole value of this table after the fact. "Skipped" on
  -- its own sends you digging; "No email address on file" is a thing to go
  -- and fix. So an expired row is asked WHY it never went, rather than all
  -- of them being filed under "missed its window".
  --
  -- Note that a suppressed row is left pending until the window closes
  -- rather than being killed on sight — deliberately. An address added on
  -- day five, or an opt-out reversed, still catches its email.
  with dead as (
    update public.follow_ups f
    set status = 'skipped',
        note = case
          when j.status <> 'completed'
            then 'Job is ' || j.status || ' now, not completed'
          when c.id is null
            then 'Customer no longer exists'
          -- Opt-out BEFORE "no way to reach them", because it is the more
          -- useful answer. Both are true of an unsubscribed customer with no
          -- phone; only one of them is a thing somebody might go and fix.
          when coalesce(c.email_opt_out, false)
            then 'Customer unsubscribed'
          when public.sb_follow_up_channel(c.email, c.email_opt_out, c.phone) is null
            then case
              when public.sb_sms_e164(c.phone) is not null
                then 'No email address, and that number has replied STOP'
              else 'No email address or phone number on file'
            end
          when c.reviewed_at is not null
            then 'Already left a review'
          when c.last_review_request_at is not null
               and c.last_review_request_at >= now()
                   - (public.sb_follow_up_quiet_months() || ' months')::interval
            then 'Already asked for a review recently'
          else 'Missed its window ('
               || public.sb_follow_up_window_days() || ' days)'
        end
    from public.jobs j
    left join public.customers c on c.id = j.customer_id
    where f.job_id = j.id
      and f.status = 'pending'
      and (
        j.status <> 'completed'
        or j.completed_at < now()
             - (public.sb_follow_up_window_days() || ' days')::interval
      )
    returning f.id
  )
  select count(*) into closed from dead;

  return closed;
end;
$$;

comment on function public.sweep_follow_ups() is
  'Close out queued follow-ups that can no longer legitimately be sent, and
   release claims from a run that died. Called before every send.';

-- ---------------------------------------------------------------------------
-- 5. Claiming what is due
-- ---------------------------------------------------------------------------

-- Returns the rows to send AND marks them claimed in the same statement.
--
-- Two runs overlapping (the daily schedule and someone pressing "Send now")
-- both read the same candidate ids, then both try the UPDATE. The second
-- blocks on the row lock, and when it clears Postgres re-checks the WHERE
-- against the new version of the row — where status is now 'sending', so it
-- matches nothing and the second run gets zero rows. That re-check is why
-- `f.status = 'pending'` appears on the UPDATE itself and not only in the
-- subquery. Without it, both runs would send.
create or replace function public.claim_follow_ups(p_limit int default 25)
returns table (
  follow_up_id  bigint,
  job_id        uuid,
  customer_id   uuid,
  customer_name text,
  -- 'email' or 'sms'. Never null here: a row with no route is excluded
  -- below and closed out by the sweep instead.
  channel       text,
  email         text,
  phone         text,
  services      text,
  amount        numeric,
  job_date      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with eligible as (
    -- DISTINCT ON customer: at most one email per person per run.
    --
    -- The quiet period below can't do this on its own, because
    -- last_review_request_at is stamped by mark_follow_up_sent — which runs
    -- AFTER the whole batch is claimed. So a customer with two jobs
    -- completing in the same window (two properties done the same day, or a
    -- one-off extra alongside a plan visit) passed the check twice and got
    -- two identical emails minutes apart.
    --
    -- The loser stays pending rather than being dropped. It can never send
    -- afterwards, because by then last_review_request_at is set and the
    -- quiet period excludes it; the sweep closes it out as "already asked
    -- for a review recently" when its window lapses. Which is the truth.
    select distinct on (f.customer_id) f.id, f.due_at
    from public.follow_ups f
    join public.jobs j      on j.id = f.job_id
    join public.customers c on c.id = f.customer_id
    where f.status = 'pending'
      and f.due_at <= now()
      -- Re-checked here, not trusted from queue time. Three days is long
      -- enough for any of these to have changed.
      and j.status = 'completed'
      and j.completed_at > now()
            - (public.sb_follow_up_window_days() || ' days')::interval
      -- Some way to ask them. Was `c.email is not null and not opted out`;
      -- the opt-out is still in there, inside the function, along with the
      -- text route for customers who are a phone number and nothing else.
      and public.sb_follow_up_channel(c.email, c.email_opt_out, c.phone) is not null
      -- Already left one. Asking again is the one thing guaranteed to
      -- annoy the customers who have been most generous.
      and c.reviewed_at is null
      and (
        c.last_review_request_at is null
        or c.last_review_request_at < now()
             - (public.sb_follow_up_quiet_months() || ' months')::interval
      )
      -- Nothing already in flight for this person. DISTINCT ON only
      -- deduplicates WITHIN one run; this closes the gap BETWEEN two
      -- overlapping ones, where run A has claimed a customer's first row
      -- but not yet marked it sent — so the quiet period isn't stamped and
      -- run B would happily take their second row.
      and not exists (
        select 1 from public.follow_ups f2
        where f2.customer_id = f.customer_id
          and f2.status = 'sending'
      )
    -- The oldest due date wins the tie: the job they've been waiting on
    -- longest is the one the email should be about.
    order by f.customer_id, f.due_at
  ),
  candidates as (
    select id from eligible
    order by due_at
    limit greatest(p_limit, 0)
  ),
  claimed as (
    update public.follow_ups f
    set status   = 'sending',
        attempts = f.attempts + 1
    where f.id in (select id from candidates)
      and f.status = 'pending'
    returning f.id, f.job_id, f.customer_id
  )
  select cl.id, cl.job_id, cl.customer_id,
         c.name,
         public.sb_follow_up_channel(c.email, c.email_opt_out, c.phone),
         c.email,
         -- E.164, because that is what the sender hands to claim_sms and
         -- what the outbox stores. Handing on whatever was typed into the
         -- CRM would mean the row and the message could disagree about who
         -- was texted.
         public.sb_sms_e164(c.phone),
         j.services,
         coalesce(j.final_price, j.price),
         coalesce(j.completed_at, j.starts_at)
  from claimed cl
  join public.jobs j      on j.id = cl.job_id
  join public.customers c on c.id = cl.customer_id;
end;
$$;

comment on function public.claim_follow_ups(int) is
  'Take the follow-ups that are due, marking them claimed atomically.
   Every suppression rule is applied here, at send time.';

-- ---------------------------------------------------------------------------
-- 5b. Sending one, to one customer, on purpose
-- ---------------------------------------------------------------------------

-- For "ask this one for a review now" and for testing against a test
-- customer. Returns the same shape as claim_follow_ups so the sender treats
-- a batch of one no differently from a batch of ten.
--
-- WHICH RULES THIS SKIPS, AND WHY.
--
-- Skipped: the due date, and the quiet period. Both exist to stop the
-- AUTOMATION being thoughtless — sending too early, or asking a quarterly
-- customer four times a year. A person clicking a button for one named
-- customer is the judgement those rules stand in for, so they'd only be in
-- the way. Skipping the quiet period is also what makes this testable: you
-- can send to the same test customer twice in a row.
--
-- NOT skipped: the opt-out, and needing an address. An unsubscribe is a
-- request from the customer, not a scheduling rule — honouring it only when
-- convenient is how a business ends up in front of the FTC. Refused loudly
-- with a message the CRM can show, rather than returning no rows, because
-- "nothing happened" is the worst possible answer to a button press.
create or replace function public.claim_manual_follow_up(p_customer_id uuid)
returns table (
  follow_up_id  bigint,
  job_id        uuid,
  customer_id   uuid,
  customer_name text,
  channel       text,
  email         text,
  phone         text,
  services      text,
  amount        numeric,
  job_date      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cust public.customers;
  jb   public.jobs;
  fid  bigint;
  how  text;
begin
  select * into cust from public.customers where id = p_customer_id;

  if cust.id is null then
    raise exception 'No customer with that id';
  end if;

  -- The opt-out is checked FIRST and on its own, so the message says what
  -- actually happened. Folded into the channel check below it would come
  -- out as "no way to reach them", which is both wrong and the kind of
  -- thing somebody fixes by typing in a phone number.
  if coalesce(cust.email_opt_out, false) then
    raise exception '% asked not to be sent review requests', coalesce(cust.name, 'This customer');
  end if;

  how := public.sb_follow_up_channel(cust.email, cust.email_opt_out, cust.phone);

  if how is null then
    if public.sb_sms_e164(cust.phone) is not null then
      raise exception
        'No email address for %, and that number has replied STOP to a text',
        coalesce(cust.name, 'this customer');
    end if;
    raise exception
      'No email address or mobile number on file for %',
      coalesce(cust.name, 'this customer');
  end if;

  -- The email says what we did and when, so it needs a job to point at.
  -- A completed one first; failing that the most recent of any status, which
  -- is what a test customer with a scheduled job will have.
  select * into jb
  from public.jobs j
  where j.customer_id = cust.id
  order by
    (j.status = 'completed') desc,
    coalesce(j.completed_at, j.starts_at) desc nulls last
  limit 1;

  if jb.id is null then
    raise exception '% has no jobs yet, and the email refers to work we did', coalesce(cust.name, 'This customer');
  end if;

  -- Reuse the row for that job rather than adding a second. follow_ups holds
  -- the STATE of a job's follow-up, and a job has one; contact_log is where
  -- each individual send is recorded, so re-sending doesn't lose the fact
  -- that an earlier one went. That's also why the unique constraint on
  -- job_id can stay exactly as strict as it is.
  --
  -- Written as update-then-insert rather than INSERT ... ON CONFLICT because
  -- this function's RETURNS TABLE puts `job_id` and `customer_id` in scope as
  -- variables, and a conflict target is an expression context — so
  -- `on conflict (job_id)` is genuinely ambiguous and Postgres rejects it.
  -- Renaming the output columns would have fixed it too, but they are the
  -- field names the sender reads.
  update public.follow_ups f
  set status   = 'sending',
      attempts = f.attempts + 1,
      note     = null
  where f.job_id = jb.id
  returning f.id into fid;

  if fid is null then
    insert into public.follow_ups (job_id, customer_id, kind, due_at, status, attempts)
    values (jb.id, cust.id, 'review', now(), 'sending', 1)
    returning id into fid;
  end if;

  return query
  select fid, jb.id, cust.id, cust.name,
         how, cust.email, public.sb_sms_e164(cust.phone),
         jb.services,
         coalesce(jb.final_price, jb.price),
         coalesce(jb.completed_at, jb.starts_at);
end;
$$;

comment on function public.claim_manual_follow_up(uuid) is
  'Queue and claim a review request for one named customer, now. Ignores the
   due date and quiet period; still refuses an opt-out, and still refuses a
   customer with neither an email address nor a textable number.';

grant execute on function public.claim_manual_follow_up(uuid) to service_role;

-- What WOULD go out, changing nothing. This is what the dry-run mode reads,
-- and what the "who is this about to email?" question should be answered
-- with — never by running the real thing and watching.
create or replace function public.preview_follow_ups(p_limit int default 25)
returns table (
  follow_up_id  bigint,
  customer_name text,
  channel       text,
  email         text,
  phone         text,
  due_at        timestamptz,
  job_date      timestamptz
)
language sql
security definer
set search_path = public
as $$
  -- DISTINCT ON customer, exactly as claim_follow_ups does. A preview that
  -- listed two emails where the real run sends one would be worse than no
  -- preview: the whole value of this function is that it tells the truth
  -- about what is about to happen.
  with eligible as (
    select distinct on (f.customer_id)
           f.id, c.name,
           public.sb_follow_up_channel(c.email, c.email_opt_out, c.phone) as channel,
           c.email, public.sb_sms_e164(c.phone) as phone, f.due_at,
           coalesce(j.completed_at, j.starts_at) as job_date
    from public.follow_ups f
    join public.jobs j      on j.id = f.job_id
    join public.customers c on c.id = f.customer_id
    where f.status = 'pending'
      and f.due_at <= now()
      and j.status = 'completed'
      and j.completed_at > now()
            - (public.sb_follow_up_window_days() || ' days')::interval
      -- The same single condition claim_follow_ups uses, for the same
      -- reason: the whole value of a preview is that it is not a different
      -- query from the real thing.
      and public.sb_follow_up_channel(c.email, c.email_opt_out, c.phone) is not null
      -- Already left one. Asking again is the one thing guaranteed to
      -- annoy the customers who have been most generous.
      and c.reviewed_at is null
      and (
        c.last_review_request_at is null
        or c.last_review_request_at < now()
             - (public.sb_follow_up_quiet_months() || ' months')::interval
      )
    order by f.customer_id, f.due_at
  )
  select id, name, channel, email, phone, due_at, job_date
  from eligible
  order by due_at
  limit greatest(p_limit, 0);
$$;

-- ---------------------------------------------------------------------------
-- 6. Recording the outcome
-- ---------------------------------------------------------------------------

-- Idempotent: calling it twice for the same row is a no-op the second time,
-- which is what makes the stuck-claim recovery in sweep_follow_ups() safe.
create or replace function public.mark_follow_up_sent(
  p_id          bigint,
  p_provider_id text default null,
  p_email       text default null,
  -- 'email' or 'sms'. Defaulted so an old caller still works, and so the
  -- meaning of a row written before this column existed is the true one.
  p_channel     text default 'email'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cust uuid;
begin
  update public.follow_ups
  set status      = 'sent',
      sent_at     = now(),
      sent_to     = p_email,
      provider_id = p_provider_id,
      note        = null
  where id = p_id
    and status <> 'sent'
  returning customer_id into cust;

  if cust is null then
    return;                        -- already sent, or no such row
  end if;

  -- Starts the quiet period. This is the column that stops a quarterly
  -- customer being asked four times a year.
  update public.customers
  set last_review_request_at = now()
  where id = cust;

  -- Put it on the contact history, so the timeline shows what the business
  -- sent as well as what a human did — otherwise a customer replies about
  -- an email nobody in the CRM can see.
  --
  -- Written directly rather than through record_contact(), which also bumps
  -- contact_attempts and last_contacted_at. Those mean "we chased this
  -- person"; an automatic email shouldn't make a quiet customer look worked.
  --
  -- kind 'auto_email' rather than 'email' so the timeline can say who sent
  -- it. contact_log.kind is free text by design.
  --
  -- NOT FOR A TEXT. mark_sms_sent() already wrote a contact_log row for it,
  -- with the actual words that were sent in it — a better record than this
  -- one. Writing both is how a timeline ends up showing one message twice,
  -- which is exactly the complaint that got the duplicate invoice rows
  -- cleaned out of job history.
  if coalesce(p_channel, 'email') <> 'sms' then
    insert into public.contact_log (customer_id, phone_norm, kind, detail)
    select cust, public.sb_phone_digits(c.phone), 'auto_email',
           'Review request'
    from public.customers c
    where c.id = cust;
  end if;
end;
$$;

create or replace function public.mark_follow_up_failed(
  p_id    bigint,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.follow_ups
  set
    -- Three goes, then stop. A permanently bad address should show up as a
    -- thing to fix, not retry every morning until someone notices.
    status = case when attempts >= 3 then 'skipped' else 'failed' end,
    note   = left(coalesce(p_error, 'Unknown error'), 500)
  where id = p_id;

  -- A 'failed' row is picked up again by the next run; put it back in the
  -- queue explicitly rather than relying on status names lining up.
  update public.follow_ups
  set status = 'pending'
  where id = p_id and status = 'failed';
end;
$$;

-- We didn't try, as distinct from we tried and it failed.
--
-- The text route can come back "not now" for reasons that are nothing to do
-- with the customer: SMS_MODE is off or in preview, Quo isn't configured, or
-- it is outside the 9am-8pm window. Those are states of the system, not
-- facts about the person.
--
-- Routed through mark_follow_up_failed() they would each burn one of the
-- three attempts, and a customer whose text landed on three consecutive
-- quiet mornings would be marked 'skipped' and never asked at all — the
-- queue deciding, silently, that a config setting meant "this person does
-- not get a review request". So a deferral puts the row back exactly as it
-- was found, attempt and all, and says in the note why.
create or replace function public.mark_follow_up_deferred(
  p_id     bigint,
  p_reason text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.follow_ups
  set status   = 'pending',
      -- Undoing the increment claim_follow_ups made. greatest() because a
      -- row that was somehow claimed at zero should not go negative.
      attempts = greatest(attempts - 1, 0),
      note     = left(coalesce(nullif(btrim(p_reason), ''), 'Deferred'), 500)
  where id = p_id
    and status = 'sending';
$$;

comment on function public.mark_follow_up_deferred(bigint, text) is
  'Put a claimed follow-up back in the queue without counting the attempt.
   For "not now" — quiet hours, texting switched off — never for a refusal.';

-- Marked skipped by a person, from the job page, during the three-day wait.
-- The one manual brake: a job that went badly, or a customer you'd rather
-- ring yourself.
create or replace function public.skip_follow_up(p_job_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.follow_ups
  set status = 'skipped',
      note   = coalesce(nullif(btrim(p_reason), ''), 'Skipped by hand')
  where job_id = p_job_id
    and status in ('pending', 'failed');
end;
$$;

-- Someone clicked "unsubscribe". Sets the flag, cancels anything already
-- queued for them, and — the part that matters — puts it on the contact
-- history, so the next person to open that customer sees they asked not to
-- be emailed rather than wondering why the automation went quiet.
create or replace function public.record_email_opt_out(p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  -- NOT named `found`: that is a built-in PL/pgSQL variable, and declaring
  -- one over it makes `if not found` read the wrong thing — which is how
  -- the first version of this cheerfully reported success for a customer
  -- id that doesn't exist.
  hit uuid;
begin
  update public.customers
  set email_opt_out = true
  where id = p_customer_id
  returning id into hit;

  if hit is null then
    return false;
  end if;

  update public.follow_ups
  set status = 'skipped',
      note   = 'Customer unsubscribed'
  where customer_id = p_customer_id
    and status in ('pending', 'failed');

  insert into public.contact_log (customer_id, phone_norm, kind, detail)
  select p_customer_id, public.sb_phone_digits(c.phone), 'opt_out',
         'Unsubscribed from follow-up emails'
  from public.customers c
  where c.id = p_customer_id;

  return true;
end;
$$;

grant execute on function public.record_email_opt_out(uuid)   to service_role;
grant execute on function public.skip_follow_up(uuid, text)   to authenticated;
grant execute on function public.preview_follow_ups(int)      to authenticated;

grant execute on function public.claim_follow_ups(int)        to service_role;
grant execute on function public.claim_manual_follow_up(uuid) to service_role;
grant execute on function public.mark_follow_up_sent(bigint, text, text, text) to service_role;
grant execute on function public.sb_follow_up_channel(text, boolean, text) to service_role;
grant execute on function public.sb_follow_up_channel(text, boolean, text) to authenticated;
grant execute on function public.mark_follow_up_failed(bigint, text)     to service_role;
grant execute on function public.mark_follow_up_deferred(bigint, text)   to service_role;
grant execute on function public.sweep_follow_ups()           to service_role;
grant execute on function public.preview_follow_ups(int)      to service_role;

-- ---------------------------------------------------------------------------
-- 7. What you've got
-- ---------------------------------------------------------------------------

select
  f.status,
  count(*) as rows,
  min(f.due_at) as earliest_due,
  max(f.sent_at) as last_sent
from public.follow_ups f
group by f.status
order by f.status;
