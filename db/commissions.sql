-- Sky Blue CRM — the commission ledger
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- REQUIRES db/roles-and-commissions.sql to have been run first — this file
-- builds on profiles.commission_* and sb_commission_rate().
--
-- PHASE 2 of claude/crm-commissions-spec.md. This creates and settles the
-- rows. The page that displays them is Phase 3.
--
-- ---------------------------------------------------------------------------
-- The model in one paragraph
-- ---------------------------------------------------------------------------
--
-- Three things earn money on a job: finding the lead (10%), booking it
-- (10%), and working it (20%). Rates are per-rep overridable. LLC members
-- earn nothing. Find and book are earned once per LEAD — so a recurring
-- customer does not pay a finder's fee every three months — while work is
-- earned per JOB, so the person who actually turns up gets paid each visit.
--
-- Nothing is payable until the money is in. A row is 'pending' from the
-- moment it is earned until the job is both completed AND paid, at which
-- point its base is re-read from the real final price (so an upsell lifts
-- everyone's cut) and it becomes 'payable'.

-- ---------------------------------------------------------------------------
-- 1. Knobs
-- ---------------------------------------------------------------------------

-- The most that can be paid out in TOTAL for working one job, however many
-- people are on it. Without a cap, per-head rates scale linearly: two people
-- on a job costs 40% and four costs 80%, for work that was going to be done
-- either way. With the cap, each person's rate is scaled down
-- proportionally once the sum exceeds it:
--
--   1 worker  -> 20%          (under the cap, untouched)
--   2 workers -> 15% each     (40 scaled to 30)
--   3 workers -> 10% each     (60 scaled to 30)
--
-- Combined with 20% to a rep who found and booked, the maximum the business
-- ever pays out on a job is 50%.
create or replace function public.sb_commission_work_cap()
returns numeric language sql immutable as $$ select 30::numeric $$;

-- Commissions are not backdated. Nobody was promised a cut of work done
-- before there were employees, and minting ledger rows over historical jobs
-- would invent debts that were never owed.
--
-- CHANGE THIS DATE if you run this file later than you meant to — it is
-- compared against leads.created_at and jobs.created_at, so anything older
-- is silently ignored by every trigger below.
create or replace function public.sb_commission_go_live()
returns timestamptz language sql immutable as $$ select '2026-09-12T00:00:00Z'::timestamptz $$;

-- How long a lead must sit untouched before killing it releases the
-- commission on it.
--
-- Without this, the reset is a two-click theft: any rep can open a
-- colleague's live lead, set it to Archived — voiding their fee — set it
-- straight back to Contacted, and walk off with the commission. Nothing
-- gates who may change a lead's status, so the only defence is refusing to
-- release a fee on a lead that was still moving.
--
-- Measured from the last status change, matching STALE_AFTER_DAYS in
-- src/services/leadService.js (21) in kind if not in number: that one
-- decides when the board nags you, this one decides when you lose the
-- money, and losing money should be slower than being nagged.
create or replace function public.sb_commission_stale_days()
returns integer language sql immutable as $$ select 30 $$;

-- The lead statuses that earn a finder's fee when a lead is CREATED at one.
--
-- 'new' is deliberately absent. It is website-only (MANUAL_ADD_STAGES in
-- src/services/leadService.js offers contacted/quoted/booked and nothing
-- else), and the distinction is load-bearing: creating a lead at
-- 'contacted' means you spoke to somebody, whereas a 'new' row is an
-- address someone typed. Were 'new' to earn, a rep could enter two hundred
-- addresses and collect on everything the team later converted.
create or replace function public.sb_commission_find_statuses()
returns text[] language sql immutable as $$ select array['contacted','quoted','booked'] $$;

-- ---------------------------------------------------------------------------
-- 2. The ledger
-- ---------------------------------------------------------------------------

create table if not exists public.commissions (
  id          bigint generated always as identity primary key,

  -- Both, usually. A find/book row is born before any job exists, so it
  -- starts with only a lead_id and is linked to the job when one is
  -- scheduled. A work row is born with only a job_id — a recurring visit
  -- has no lead of its own.
  lead_id     uuid references public.leads (id) on delete cascade,
  job_id      uuid references public.jobs (id) on delete cascade,

  profile_id  uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('find', 'book', 'work')),

  -- SNAPSHOTS, both of them, and this is the most important line in the
  -- file. Raising someone's rate next spring must not rewrite what they
  -- were owed last autumn, and re-pricing a job must not silently restate
  -- a commission that has already been paid. Nothing here is ever
  -- recomputed from live data once the row is 'paid'.
  --
  -- `rate` is the EFFECTIVE percent after the work cap, not the nominal
  -- one — so a paired job records 15, which is what was actually paid,
  -- rather than 20 with the arithmetic hidden somewhere else.
  rate        numeric(5,2) not null,
  base_amount numeric(12,2) not null default 0,
  amount      numeric(12,2) not null default 0,

  status      text not null default 'pending'
              check (status in ('pending', 'payable', 'paid', 'void')),

  earned_at   timestamptz not null default now(),
  payable_at  timestamptz,
  paid_at     timestamptz,
  note        text,

  -- Set on a negative row that offsets an earlier one (a refund, a
  -- cancelled job). It exists so the unique indexes below can tell an
  -- earning from its reversal: without it, booking a -£90 correction
  -- against a lead collides with the very row it is correcting, and the
  -- reversal is rejected by the constraint that was supposed to stop
  -- double-PAYING. Caught by the reversal case in verify/commissions.sql.
  reversal_of bigint references public.commissions (id) on delete set null
);

alter table public.commissions
  add column if not exists reversal_of bigint references public.commissions (id) on delete set null;

comment on table public.commissions is
  'One row per person per thing-they-did on a job. Written only by triggers; see db/commissions.sql.';

-- One LIVE finder's fee and one live booking fee per lead. This is what
-- makes a recurring customer stop paying them after the first visit, and
-- what makes the first person to book a lead the one who earns it.
--
-- Voided rows are excluded, and that exclusion is what lets a dead lead be
-- re-earned. When a lead is lost or archived its pending fees are voided
-- (section 5b), which frees the slot; whoever brings it back to life takes
-- the fee. Sit on a lead until it goes cold and you don't keep the
-- commission for it.
drop index if exists commissions_one_per_lead;
create unique index if not exists commissions_one_per_lead
  on public.commissions (lead_id, kind)
  where kind in ('find', 'book')
     and reversal_of is null
     and status <> 'void';

-- One work fee per person per JOB. Two people on a job get a row each;
-- the same person cannot be paid twice for the same visit.
drop index if exists commissions_one_work_per_job;
create unique index if not exists commissions_one_work_per_job
  on public.commissions (job_id, profile_id)
  where kind = 'work' and reversal_of is null;

create index if not exists commissions_by_profile
  on public.commissions (profile_id, status);
create index if not exists commissions_by_job
  on public.commissions (job_id);

-- ---------------------------------------------------------------------------
-- 3. Recalculating a job
-- ---------------------------------------------------------------------------

-- Re-derive base amounts, apply the work cap, and recompute money for every
-- unpaid row attached to one job.
--
-- Called from three places — a tech being added, a tech being removed, and
-- the job being settled — because all three change the answer. Adding a
-- second person to a job halves what the first one earns, and that has to
-- show up on the pending figure immediately rather than as a surprise on
-- payday.
--
-- 'paid' rows are never touched. Money that has left the business is
-- history, not a calculation.
create or replace function public.sb_sync_job_commissions(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base       numeric;
  v_lead_id    uuid;
  v_nominal    numeric;
  v_scale      numeric;
begin
  select coalesce(j.final_price, j.price, 0), j.lead_id
    into v_base, v_lead_id
    from public.jobs j
   where j.id = p_job_id;

  if not found then
    return;
  end if;

  -- Find and book rows are born on the lead, before a job exists. Adopt
  -- them the first time we see a job for that lead, so the ledger can
  -- answer "what did this job cost us in commission" in one query.
  if v_lead_id is not null then
    update public.commissions
       set job_id = p_job_id
     where lead_id = v_lead_id
       and kind in ('find', 'book')
       and job_id is null;
  end if;

  -- Work: scale every rate down proportionally if they sum past the cap.
  -- Proportional rather than equal shares because rates can differ per
  -- rep — a senior tech on 25% and a new one on 20% should keep their
  -- relative standing when the cap bites, not be flattened to the same
  -- number.
  -- Sum the NOMINAL rates from the profiles, not the stored ones.
  --
  -- Storing the scaled rate and then summing it is a feedback loop, and it
  -- silently overpays: with two workers already scaled to 15 each, adding a
  -- third summed 15+15+20 = 50 instead of 60, scaled by 30/50, and paid
  -- three people 12% apiece — 36% of the job against a 30% cap. Caught by
  -- the three-worker case in verify/commissions.sql.
  --
  -- Includes rows already paid. Their money has gone and cannot be scaled
  -- back, but counting them keeps a later addition from pushing the job's
  -- total further past the cap than it already is.
  select sum(public.sb_commission_rate(c.profile_id, 'work')) into v_nominal
    from public.commissions c
   where c.job_id = p_job_id
     and c.kind = 'work'
     and c.status <> 'void'
     and c.reversal_of is null;

  if coalesce(v_nominal, 0) > public.sb_commission_work_cap() then
    v_scale := public.sb_commission_work_cap() / v_nominal;
  else
    v_scale := 1;
  end if;

  -- The nominal rate is re-read from the profile each time rather than
  -- kept alongside the scaled one. Storing both invites them to disagree,
  -- and the profile is the only place a rate is authored.
  update public.commissions c
     set rate = round(public.sb_commission_rate(c.profile_id, 'work') * v_scale, 2),
         base_amount = v_base,
         amount = round(
           v_base * round(public.sb_commission_rate(c.profile_id, 'work') * v_scale, 2) / 100,
           2)
   where c.job_id = p_job_id
     and c.kind = 'work'
     and c.status <> 'paid'
     and c.reversal_of is null;

  -- Find and book are never capped — there is only ever one of each.
  update public.commissions c
     set base_amount = v_base,
         amount = round(v_base * c.rate / 100, 2)
   where c.job_id = p_job_id
     and c.kind in ('find', 'book')
     and c.status not in ('paid', 'void')
     and c.reversal_of is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Earning: the finder's fee
-- ---------------------------------------------------------------------------

create or replace function public.sb_commission_on_lead_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate numeric;
begin
  -- Website leads arrive with created_by null (they insert their own rows
  -- under the anon key, so there is no auth.uid() to attribute to) and
  -- land on 'new'. Either condition alone is enough to earn nothing; both
  -- are checked because either could change independently.
  if new.created_by is null then
    return new;
  end if;

  if not (new.status = any (public.sb_commission_find_statuses())) then
    return new;
  end if;

  if new.created_at < public.sb_commission_go_live() then
    return new;
  end if;

  v_rate := public.sb_commission_rate(new.created_by, 'find');
  if v_rate <= 0 then
    return new; -- an owner, or a rep explicitly set to zero
  end if;

  insert into public.commissions
    (lead_id, profile_id, kind, rate, base_amount, amount, status)
  values
    (new.id, new.created_by, 'find', v_rate,
     coalesce(new.estimate, 0),
     round(coalesce(new.estimate, 0) * v_rate / 100, 2),
     'pending')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists commissions_lead_insert on public.leads;
create trigger commissions_lead_insert
  after insert on public.leads
  for each row
  execute function public.sb_commission_on_lead_insert();

-- A lead's estimate is usually entered at 'contacted' with no price, then
-- filled in at 'quoted'. Keep the pending figure honest as that happens —
-- otherwise a rep's Commission tab shows £0 against a £600 quote until the
-- job settles.
create or replace function public.sb_commission_on_lead_estimate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.estimate is distinct from old.estimate then
    update public.commissions c
       set base_amount = coalesce(new.estimate, 0),
           amount = round(coalesce(new.estimate, 0) * c.rate / 100, 2)
     where c.lead_id = new.id
       and c.kind in ('find', 'book')
       and c.status = 'pending'
       -- Once a job exists, the job's price is the truth and the lead's
       -- estimate is a stale memory of what was quoted.
       and c.job_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists commissions_lead_estimate on public.leads;
create trigger commissions_lead_estimate
  after update of estimate on public.leads
  for each row
  execute function public.sb_commission_on_lead_estimate();

-- ---------------------------------------------------------------------------
-- 5. Earning: the booking fee
-- ---------------------------------------------------------------------------

-- Everything a change of lead status does to the ledger.
--
-- Reads lead_events rather than watching leads.status directly, which buys
-- two things. The actor is already resolved there (leads has no "who
-- changed this" column), and the trigger fires `after insert or update`, so
-- a lead CREATED at 'booked' produces an event with from_status null and
-- to_status 'booked' — meaning a rep who skips the pipeline and books
-- immediately earns find + book = 20% with no special case anywhere.
--
-- Three things happen here:
--
--   lost / archived  -> void the pending fees. The lead died; nobody is
--                       owed for it. Only PENDING rows — a fee that already
--                       became payable belongs to a job that finished and
--                       was paid for, and archiving the old lead afterwards
--                       must not claw that back.
--
--   contacted /      -> make sure a finder's fee exists, owned by whoever
--   quoted /            made this move. Normally a no-op: the fee was
--   booked              created when the lead was inserted, and the unique
--                       index quietly rejects a second one. It only bites
--                       after a lead has been killed and revived, which is
--                       the point — sit on a lead until it goes cold and
--                       whoever resurrects it takes the fee.
--
--   booked           -> the booking fee, to whoever closed it.
create or replace function public.sb_commission_on_lead_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate     numeric;
  v_estimate numeric;
  v_created  timestamptz;
  v_moved_at timestamptz;
begin
  if new.to_status is null then
    return new;
  end if;

  select l.estimate, l.created_at
    into v_estimate, v_created
    from public.leads l
   where l.id = new.lead_id;

  if v_created is null or v_created < public.sb_commission_go_live() then
    return new;
  end if;

  -- --- the lead died -------------------------------------------------
  if new.to_status in ('lost', 'archived') then
    -- Only if it had genuinely gone quiet first. `moved_at` is the last
    -- status change BEFORE this one (this trigger is AFTER INSERT, so the
    -- killing event is already in the table and has to be excluded by id).
    -- A lead with no prior transition falls back to when it was created.
    select coalesce(
             (select max(e.created_at)
                from public.lead_events e
               where e.lead_id = new.lead_id
                 and e.id <> new.id
                 and e.to_status is not null),
             (select l.created_at from public.leads l where l.id = new.lead_id)
           )
      into v_moved_at;

    if v_moved_at is null
       or v_moved_at > now() - make_interval(days => public.sb_commission_stale_days())
    then
      -- Still warm. Killing it loses the lead but not the fee: whoever
      -- worked it keeps their claim, and reviving it later pays nobody new.
      return new;
    end if;

    update public.commissions
       set status = 'void',
           note = coalesce(note || ' · ', '')
                  || 'Lead ' || new.to_status || ' after '
                  || extract(day from now() - v_moved_at)::int
                  || ' quiet days — commission reset'
     where lead_id = new.lead_id
       and kind in ('find', 'book')
       and status = 'pending';
    return new;
  end if;

  if new.changed_by is null then
    return new; -- website insert, or an actor with no profile row
  end if;

  -- --- back among the living -------------------------------------------
  if new.to_status in ('contacted', 'quoted', 'booked') then
    v_rate := public.sb_commission_rate(new.changed_by, 'find');
    if v_rate > 0 then
      -- Conflicts against the live finder's fee on every ordinary move
      -- (contacted -> quoted and so on), which is exactly right: moving a
      -- lead along pays nobody. It only inserts when there is no live fee,
      -- i.e. on the first touch or after a reset.
      insert into public.commissions
        (lead_id, profile_id, kind, rate, base_amount, amount, status)
      values
        (new.lead_id, new.changed_by, 'find', v_rate,
         coalesce(v_estimate, 0),
         round(coalesce(v_estimate, 0) * v_rate / 100, 2),
         'pending')
      on conflict do nothing;
    end if;
  end if;

  -- --- closed ------------------------------------------------------------
  if new.to_status = 'booked' then
    v_rate := public.sb_commission_rate(new.changed_by, 'book');
    if v_rate > 0 then
      -- Same conflict rule makes the FIRST closer the one who earns it, so
      -- a lead bouncing booked -> lost -> booked pays the booking fee once
      -- — to whoever closed it after the reset.
      insert into public.commissions
        (lead_id, profile_id, kind, rate, base_amount, amount, status)
      values
        (new.lead_id, new.changed_by, 'book', v_rate,
         coalesce(v_estimate, 0),
         round(coalesce(v_estimate, 0) * v_rate / 100, 2),
         'pending')
      on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

-- The old name, dropped explicitly: this file has been run before under it,
-- and leaving it attached would double every booking fee.
drop trigger if exists commissions_booked on public.lead_events;
drop function if exists public.sb_commission_on_booked();

drop trigger if exists commissions_lead_event on public.lead_events;
create trigger commissions_lead_event
  after insert on public.lead_events
  for each row
  execute function public.sb_commission_on_lead_event();

-- ---------------------------------------------------------------------------
-- 6. Earning: the work fee
-- ---------------------------------------------------------------------------

create or replace function public.sb_commission_on_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate    numeric;
  v_created timestamptz;
begin
  -- coalesce(starts_at, created_at), not created_at alone. A job's
  -- created_at is when the ROW was typed; starts_at is when the work
  -- happened. "Add past jobs" imports finished work with a starts_at
  -- months ago and a created_at of just now, so keying on created_at
  -- would mint commission on history the moment anyone assigned a tech
  -- to an imported job. (It doesn't today — addPastJobs writes no
  -- assignments and no lead — but that is a property of one screen, not
  -- a guarantee.)
  select coalesce(j.starts_at, j.created_at) into v_created
    from public.jobs j where j.id = new.job_id;
  if v_created is null or v_created < public.sb_commission_go_live() then
    return new;
  end if;

  v_rate := public.sb_commission_rate(new.tech_id, 'work');
  if v_rate <= 0 then
    return new;
  end if;

  insert into public.commissions
    (job_id, profile_id, kind, rate, base_amount, amount, status)
  values (new.job_id, new.tech_id, 'work', v_rate, 0, 0, 'pending')
  on conflict do nothing;

  -- Recalculate the whole job, not just this row: adding a second person
  -- is what pushes the total past the cap and cuts the first person's rate.
  perform public.sb_sync_job_commissions(new.job_id);
  return new;
end;
$$;

drop trigger if exists commissions_assigned on public.job_assignments;
create trigger commissions_assigned
  after insert on public.job_assignments
  for each row
  execute function public.sb_commission_on_assigned();

-- Taking someone off a job removes what they had not yet earned, and gives
-- the people still on it their share back.
--
-- Only 'pending' rows. If they were unassigned after the job was settled,
-- the money was already earned — silently deleting it would be theft by
-- database trigger.
create or replace function public.sb_commission_on_unassigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.commissions
   where job_id = old.job_id
     and profile_id = old.tech_id
     and kind = 'work'
     and status = 'pending';

  perform public.sb_sync_job_commissions(old.job_id);
  return old;
end;
$$;

drop trigger if exists commissions_unassigned on public.job_assignments;
create trigger commissions_unassigned
  after delete on public.job_assignments
  for each row
  execute function public.sb_commission_on_unassigned();

-- ---------------------------------------------------------------------------
-- 7. Settling: money in, commission payable
-- ---------------------------------------------------------------------------

-- Fires on any change to a job, and decides from the CURRENT state rather
-- than from what changed. That matters because there are two routes to
-- settled and they arrive in different orders:
--
--   cash/card  — completeJob sets status='completed' and paid=true together
--   invoice    — completeJob sets status='completed' and paid=FALSE, and
--                paid flips true later when refreshInvoiceOnJob reads
--                Square. That second update is the one that settles it.
--
-- The reverse is handled too: if Square says an invoice is no longer paid,
-- anything still 'payable' goes back to 'pending'. Rows already marked
-- 'paid' are left alone — that is a refund, and a refund is a new negative
-- row someone writes deliberately, not a silent rewrite of history.
create or replace function public.sb_commission_on_job_settled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settled boolean;
begin
  -- Same reasoning as the assignment trigger: when the work happened,
  -- not when the row was typed.
  if coalesce(new.starts_at, new.created_at) < public.sb_commission_go_live() then
    return new;
  end if;

  v_settled := new.status = 'completed' and coalesce(new.paid, false);

  -- Re-read the money whenever price, final price or settlement changes.
  -- final_price is where an upsell lands (completeJob writes it), so this
  -- is what lifts everyone's cut when a £300 job goes out at £450.
  if new.final_price is distinct from old.final_price
     or new.price is distinct from old.price
     or v_settled is distinct from (old.status = 'completed' and coalesce(old.paid, false))
  then
    perform public.sb_sync_job_commissions(new.id);
  end if;

  if v_settled then
    update public.commissions
       set status = 'payable', payable_at = now()
     where job_id = new.id
       and status = 'pending';
  else
    update public.commissions
       set status = 'pending', payable_at = null
     where job_id = new.id
       and status = 'payable';
  end if;

  return new;
end;
$$;

drop trigger if exists commissions_job_settled on public.jobs;
create trigger commissions_job_settled
  after update on public.jobs
  for each row
  execute function public.sb_commission_on_job_settled();

-- A job being created from a booked lead is what links the find/book rows
-- to it. Without this they stay orphaned on the lead until the job settles,
-- and "what did this job cost in commission" would answer wrongly all the
-- way through the job's life.
create or replace function public.sb_commission_on_job_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.starts_at, new.created_at) >= public.sb_commission_go_live() then
    perform public.sb_sync_job_commissions(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists commissions_job_insert on public.jobs;
create trigger commissions_job_insert
  after insert on public.jobs
  for each row
  execute function public.sb_commission_on_job_insert();

-- ---------------------------------------------------------------------------
-- 7b. Who is an owner
-- ---------------------------------------------------------------------------
--
-- Defined before the payout functions that call it, and used again by the
-- RLS policy at the end. Security definer so it can read profiles even
-- once that table has policies of its own.
create or replace function public.sb_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role = 'admin'
  )
$$;

-- What the signed-in person earns, per kind.
--
-- Exists so the Commission page can state a rep's own rates without
-- hardcoding 10/10/20 in JavaScript. Trenton is on 15% for finding, so a
-- page that recites the house rates in its header while listing 15% in the
-- rows below contradicts itself about money — which is the one subject it
-- cannot afford to be vague on.
create or replace function public.sb_my_commission_rates()
returns table (find_rate numeric, book_rate numeric, work_rate numeric)
language sql
stable
security definer
set search_path = public
as $$
  select public.sb_commission_rate(auth.uid(), 'find'),
         public.sb_commission_rate(auth.uid(), 'book'),
         public.sb_commission_rate(auth.uid(), 'work')
$$;

-- ---------------------------------------------------------------------------
-- 7c. Reassigning who found a lead
-- ---------------------------------------------------------------------------
--
-- Changing leads.created_by by hand is a trap, which is why this exists as a
-- function rather than a column the app can just update. The finder's fee is
-- a SEPARATE row that was written when the lead was created and attributed
-- to whoever created it — so editing the column alone moves the credit on
-- screen while the money stays with the wrong person, silently, until
-- payday.
--
-- Four cases, all of which happen:
--
--   rep -> rep     move the row, and RE-RATE it. Trenton is on 15% and a
--                  tech is on 10%, so the same lead is worth a different
--                  amount depending on whose it is.
--   rep -> owner   delete the pending fee. Members are not on commission,
--                  so there is nobody to pay.
--   owner -> rep   create one. No row existed, because owners earn nothing.
--   already paid   leave it completely alone and say so. Money that has
--                  gone out is not rewritten by an admin fixing an
--                  attribution six weeks later.
--
-- The BOOKING fee is deliberately untouched. Who booked a lead is a
-- historical fact recorded in lead_events — reassigning who *found* it
-- says nothing about who closed it.
create or replace function public.sb_reassign_lead(
  p_lead_id   uuid,
  p_new_owner uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_owner uuid;
  v_rate      numeric;
  v_base      numeric;
  v_existing  public.commissions%rowtype;
begin
  if not public.sb_is_admin() then
    raise exception 'Only an owner can reassign a lead.' using errcode = '42501';
  end if;

  select created_by, coalesce(estimate, 0)
    into v_old_owner, v_base
    from public.leads
   where id = p_lead_id;

  if not found then
    raise exception 'No such lead.';
  end if;

  if v_old_owner is not distinct from p_new_owner then
    return 'No change.';
  end if;

  -- A job's real price beats the lead's estimate once one exists, same rule
  -- the rest of the ledger follows.
  --
  -- A scalar subquery, NOT `select ... into`. INTO sets its target to NULL
  -- when the query matches no rows, so on a lead with no job yet — the
  -- common case — it silently erased the estimate read a moment ago and
  -- every reassignment produced a $0 fee. The subquery yields NULL the same
  -- way, but the coalesce around it can then fall back.
  v_base := coalesce(
    (select coalesce(j.final_price, j.price)
       from public.jobs j
      where j.lead_id = p_lead_id
      order by j.visit_number nulls last
      limit 1),
    v_base,
    0);

  update public.leads set created_by = p_new_owner where id = p_lead_id;

  select * into v_existing
    from public.commissions
   where lead_id = p_lead_id
     and kind = 'find'
     and reversal_of is null
     and status <> 'void'
   limit 1;

  v_rate := case
              when p_new_owner is null then 0
              else public.sb_commission_rate(p_new_owner, 'find')
            end;

  if found and v_existing.status = 'paid' then
    return 'Lead reassigned. The finder''s fee was already paid out and has '
           || 'been left with the original rep — settle any correction by hand.';
  end if;

  if found then
    if v_rate > 0 then
      update public.commissions
         set profile_id = p_new_owner,
             rate = v_rate,
             base_amount = v_base,
             amount = round(v_base * v_rate / 100, 2)
       where id = v_existing.id;
      return 'Lead reassigned, and the finder''s fee moved with it at '
             || v_rate || '%.';
    else
      delete from public.commissions where id = v_existing.id;
      return 'Lead reassigned. The finder''s fee was removed — the new owner '
             || 'is not on commission.';
    end if;
  end if;

  if v_rate > 0 then
    insert into public.commissions
      (lead_id, profile_id, kind, rate, base_amount, amount, status)
    values
      (p_lead_id, p_new_owner, 'find', v_rate, v_base,
       round(v_base * v_rate / 100, 2), 'pending')
    on conflict do nothing;
    return 'Lead reassigned, and a finder''s fee created at ' || v_rate || '%.';
  end if;

  return 'Lead reassigned. No commission either way.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Paying out
-- ---------------------------------------------------------------------------

-- Marks a set of payable rows paid. Called from the admin side of the
-- Commission tab (Phase 3); exposed as a function rather than a direct
-- update so the ledger has exactly one door.
create or replace function public.sb_mark_commissions_paid(p_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- SECURITY DEFINER means this runs with the table owner's rights, so
  -- without this check any signed-in rep could call it over PostgREST and
  -- mark their own payable rows paid. The RLS policy protects reads; a
  -- definer function has to protect its own writes.
  if not public.sb_is_admin() then
    raise exception 'Only an owner can mark commissions paid.'
      using errcode = '42501';
  end if;

  update public.commissions
     set status = 'paid', paid_at = now()
   where id = any (p_ids)
     and status = 'payable';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A refund or a written-off job. A negative offsetting row rather than an
-- edit, so the ledger stays a history of what happened rather than a
-- statement of what someone currently believes.
create or replace function public.sb_reverse_commission(p_id bigint, p_note text default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id bigint;
begin
  if not public.sb_is_admin() then
    raise exception 'Only an owner can reverse a commission.'
      using errcode = '42501';
  end if;

  insert into public.commissions
    (lead_id, job_id, profile_id, kind, rate, base_amount, amount, status, note, reversal_of)
  select c.lead_id, c.job_id, c.profile_id, c.kind, c.rate,
         -c.base_amount, -c.amount, 'payable',
         coalesce(p_note, 'Reversal of commission #' || c.id), c.id
    from public.commissions c
   where c.id = p_id
  returning id into v_new_id;

  -- lead_id and job_id are kept so the reversal shows up in the same
  -- queries as the thing it reverses; `reversal_of` is what keeps it out
  -- of the unique indexes.
  update public.commissions set status = 'void' where id = p_id;
  return v_new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Row level security
-- ---------------------------------------------------------------------------
--
-- The one place in this CRM where a real boundary is both cheap and
-- obviously correct, so it goes in now rather than waiting for the general
-- RLS pass. A rep reads their own rows. An owner reads everyone's.
--
-- No insert or update policy at all: every write above is security definer,
-- so the triggers keep working while nothing can be written by hand from a
-- browser. Same pattern as lead_events and job_events.

alter table public.commissions enable row level security;



drop policy if exists "commissions readable by owner or admin" on public.commissions;
create policy "commissions readable by owner or admin"
  on public.commissions
  for select
  to authenticated
  using (profile_id = auth.uid() or public.sb_is_admin());

-- ---------------------------------------------------------------------------
-- 10. What it looks like now
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  n int;
begin
  select count(*) into n from public.commissions;
  raise notice 'Commission rows: % (0 is expected on a fresh install — nothing is backdated)', n;
  -- '%%' is a literal percent to RAISE, which eats the placeholder.
  raise notice 'Work cap: % percent. Go-live: %.',
    public.sb_commission_work_cap(), public.sb_commission_go_live();

  for r in
    select p.full_name, c.status, count(*) as rows, sum(c.amount) as total
      from public.commissions c
      join public.profiles p on p.id = c.profile_id
     group by p.full_name, c.status
     order by p.full_name, c.status
  loop
    raise notice '% | % | % row(s) | %', r.full_name, r.status, r.rows, r.total;
  end loop;
end;
$$;
