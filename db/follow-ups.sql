-- Sky Blue CRM — automatic follow-up emails after a completed job
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Three days after a job is completed, the customer gets one email: thanks,
-- what we did, a review link, and an easy way to tell us if something was
-- wrong. Sent by netlify/functions/send-follow-ups.mjs, which runs once a
-- day on a schedule.
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
          when c.email is null or btrim(c.email) = ''
            then 'No email address on file'
          when coalesce(c.email_opt_out, false)
            then 'Customer unsubscribed'
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
  email         text,
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
  with candidates as (
    select f.id
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
      and c.email is not null
      and btrim(c.email) <> ''
      and coalesce(c.email_opt_out, false) = false
      and (
        c.last_review_request_at is null
        or c.last_review_request_at < now()
             - (public.sb_follow_up_quiet_months() || ' months')::interval
      )
    order by f.due_at
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
         c.name, c.email,
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

-- What WOULD go out, changing nothing. This is what the dry-run mode reads,
-- and what the "who is this about to email?" question should be answered
-- with — never by running the real thing and watching.
create or replace function public.preview_follow_ups(p_limit int default 25)
returns table (
  follow_up_id  bigint,
  customer_name text,
  email         text,
  due_at        timestamptz,
  job_date      timestamptz
)
language sql
security definer
set search_path = public
as $$
  select f.id, c.name, c.email, f.due_at,
         coalesce(j.completed_at, j.starts_at)
  from public.follow_ups f
  join public.jobs j      on j.id = f.job_id
  join public.customers c on c.id = f.customer_id
  where f.status = 'pending'
    and f.due_at <= now()
    and j.status = 'completed'
    and j.completed_at > now()
          - (public.sb_follow_up_window_days() || ' days')::interval
    and c.email is not null
    and btrim(c.email) <> ''
    and coalesce(c.email_opt_out, false) = false
    and (
      c.last_review_request_at is null
      or c.last_review_request_at < now()
           - (public.sb_follow_up_quiet_months() || ' months')::interval
    )
  order by f.due_at
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
  p_email       text default null
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
  insert into public.contact_log (customer_id, phone_norm, kind, detail)
  select cust, public.sb_phone_digits(c.phone), 'auto_email',
         'Review request'
  from public.customers c
  where c.id = cust;
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
grant execute on function public.mark_follow_up_sent(bigint, text, text) to service_role;
grant execute on function public.mark_follow_up_failed(bigint, text)     to service_role;
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
