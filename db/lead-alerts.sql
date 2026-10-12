-- db/lead-alerts.sql
--
-- Telling Jordan and Hayden a lead came in.
--
-- Run after db/lead-ack.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT HAPPENED
-- ---------------------------------------------------------------------------
--
-- 12 October. Somebody filled in the form on skybluecleaningco.com. The lead
-- row is in this database. Nobody was told, and the first contact went out
-- two hours later.
--
-- The website submits down two paths at once (src/lib/leadSubmit.js): a row
-- straight into `leads`, and a POST to api.web3forms.com whose only job is
-- to email the business. Both run IN THE BROWSER. The database write landed
-- and the Web3Forms call did not — that domain is on several ad-blocker
-- lists, and Web3Forms has no record of the request, which is what a
-- blocked request looks like from the far end.
--
-- So the lead was never lost. The NOTIFICATION was lost, and it was the only
-- thing standing between a submitted form and somebody picking up a phone.
--
-- ---------------------------------------------------------------------------
-- WHY THE FIX IS HERE AND NOT ON THE WEBSITE
-- ---------------------------------------------------------------------------
--
-- Any notification sent from the customer's browser can be stopped by the
-- customer's browser. An ad blocker, a dropped connection, a tab closed on
-- the thank-you screen — all of them silently, all of them after the lead
-- has already been written. Making the website retry, or adding a second
-- notification service beside the first, is more of the same bet.
--
-- The CRM already sweeps for new leads EVERY MINUTE (ack-leads.mjs, which
-- texts the customer "thanks for reaching out"). The row is in the database
-- by then — that is the whole premise of the sweep — so the sweep can tell
-- the brothers too. Server-side, on a schedule this business owns, for every
-- source rather than only the website form.
--
-- The notification now depends on the same thing the lead does: the row
-- existing. There is no longer a way for one to happen without the other.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT A COLUMN
-- ---------------------------------------------------------------------------
--
-- The acknowledgment sweep claims a lead by asking whether any outbound text
-- exists for it. That works because the acknowledgment goes TO the lead.
-- This one goes to Jordan and Hayden, so there is nothing on the lead's own
-- thread to look at, and the alert must not be written there — an internal
-- "new lead from the website" sitting in the customer's text thread is a
-- mistake nobody would forgive on the day they scroll back through it.
--
-- A table, with the lead id as the primary key, is the claim. Two sweeps
-- racing both try to insert; one gets it, the other gets nothing back and
-- sends nothing. Exactly-once without a lock.


-- ---------------------------------------------------------------------------
-- 1. The claim
-- ---------------------------------------------------------------------------

create table if not exists public.lead_alerts (
  -- The lead, once. This IS the dedupe: the insert is the claim.
  lead_id uuid primary key references public.leads (id) on delete cascade,
  sent_at timestamptz not null default now()
);

comment on table public.lead_alerts is
  'One row per lead the team has been alerted about. The primary key is the
   claim — see sb_claim_lead_alerts().';

alter table public.lead_alerts enable row level security;

-- Nobody reads it from the app and nobody writes it from the app. The
-- function below is security definer and inserts regardless; leaving out
-- every policy is the honest way to say "this is the sweep's".


-- ---------------------------------------------------------------------------
-- 2. The window
-- ---------------------------------------------------------------------------
--
-- A knob rather than a number buried in a query, the same way
-- sb_lead_ack_delay() is.

create or replace function public.sb_lead_alert_stale()
returns interval
language sql
immutable
as $$ select interval '6 hours' $$;

comment on function public.sb_lead_alert_stale() is
  'How far back the alert sweep will look. Older leads are never alerted —
   a text about a form filled in yesterday is confusing, not useful.';


-- ---------------------------------------------------------------------------
-- 3. Claim and return, in one statement
-- ---------------------------------------------------------------------------

create or replace function public.sb_claim_lead_alerts(p_limit int default 10)
returns table (
  out_lead_id uuid,
  out_name    text,
  out_phone   text,
  out_email   text,
  out_address text,
  out_service text,
  out_source  text
)
language sql
volatile
security definer
set search_path = public
as $$
  with picked as (
    select l.id
    from public.leads l
    where
      -- NOT ONES SOMEBODY TYPED IN. created_by is null for a row inserted
      -- under the anon key, which is every automatic source: the website
      -- form, the Google LSA poll. A lead Jordan typed while standing on
      -- a driveway talking to the customer does not need to text Jordan
      -- about the customer he is talking to.
      l.created_by is null
      -- Recent. Without this, the first run after deploying would text the
      -- whole history of the leads table — and section 5 below closes the
      -- same hole from the other end.
      and l.created_at >= now() - public.sb_lead_alert_stale()
      and not exists (
        select 1 from public.lead_alerts a where a.lead_id = l.id
      )
    order by l.created_at
    limit greatest(p_limit, 0)
  ),
  claimed as (
    -- THE CLAIM AND THE SEND ARE NOT THE SAME STATEMENT, and that is the
    -- trade this makes knowingly. Claiming first means a lead can be marked
    -- alerted and then the text can fail — one missed alert. Sending first
    -- would mean a sweep that crashes after sending re-sends on the next
    -- run, every minute, forever.
    --
    -- A notification sent twice is worse than one sent zero times, because
    -- the second one trains somebody to ignore the first. The failure is
    -- also visible: a failed send is a line in the Netlify log and a row on
    -- the Undelivered page, whereas a duplicate is just noise that looks
    -- like the system working.
    insert into public.lead_alerts (lead_id)
    select id from picked
    on conflict (lead_id) do nothing
    returning lead_id
  )
  select
    l.id,
    nullif(btrim(coalesce(l.name, '')), ''),
    nullif(btrim(coalesce(l.phone, '')), ''),
    nullif(btrim(coalesce(l.email, '')), ''),
    nullif(btrim(coalesce(l.address, '')), ''),
    nullif(btrim(coalesce(l.service, '')), ''),
    coalesce(nullif(btrim(coalesce(l.source, '')), ''), 'unknown')
  from claimed c
  join public.leads l on l.id = c.lead_id
  order by l.created_at
$$;

comment on function public.sb_claim_lead_alerts(int) is
  'Claim up to p_limit leads nobody has been alerted about and return them.
   The insert into lead_alerts IS the claim, so two sweeps racing cannot
   both send. Returns nothing on the overwhelming majority of runs.';

revoke all on function public.sb_claim_lead_alerts(int) from public, anon, authenticated;
grant execute on function public.sb_claim_lead_alerts(int) to service_role;


-- ---------------------------------------------------------------------------
-- 4. Undoing one, for when a text did not arrive
-- ---------------------------------------------------------------------------

create or replace function public.sb_unclaim_lead_alert(p_lead_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  with gone as (
    delete from public.lead_alerts where lead_id = p_lead_id returning 1
  )
  select exists (select 1 from gone)
$$;

comment on function public.sb_unclaim_lead_alert(uuid) is
  'Forget that a lead was alerted, so the next sweep alerts it again. For
   the case where the claim succeeded and the text did not.';

revoke all on function public.sb_unclaim_lead_alert(uuid) from public, anon, authenticated;
grant execute on function public.sb_unclaim_lead_alert(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 5. Everything that already exists is already "alerted"
-- ---------------------------------------------------------------------------
--
-- THE MOST IMPORTANT TEN LINES IN THIS FILE.
--
-- Without them, the first sweep after this deploys looks at a table of
-- several hundred leads, finds none of them in lead_alerts, and starts
-- texting. The stale window in section 3 holds most of it back, but "most"
-- is not the standard when the failure is a phone buzzing forty times at
-- two in the morning about enquiries from August.
--
-- Belt and braces on purpose: the window and the backfill independently
-- prevent the same disaster, and neither is load-bearing alone.

insert into public.lead_alerts (lead_id, sent_at)
select l.id, l.created_at
from public.leads l
on conflict (lead_id) do nothing;


-- ---------------------------------------------------------------------------
-- 6. What the sweep will see
-- ---------------------------------------------------------------------------

do $$
declare
  seeded int;
  due    int;
begin
  select count(*) into seeded from public.lead_alerts;
  select count(*) into due from public.sb_claim_lead_alerts(0);

  raise notice 'lead alerts: % leads marked as already alerted, % due on the next sweep (expect 0 here, and 0 is what section 5 is for)',
    seeded, due;
end;
$$;
