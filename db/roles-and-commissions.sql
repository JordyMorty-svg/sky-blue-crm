-- Sky Blue CRM — the `partner` role and per-rep commission rates
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- This is PHASE 1 of the commission work described in
-- claude/crm-commissions-spec.md. It creates the vocabulary — a third role,
-- and somewhere to record what each person earns — but nothing computes or
-- pays anything yet. The `commissions` ledger and the report are Phase 2
-- and 3. Adding the columns now means Trenton's 15% can be recorded the day
-- he starts rather than reconstructed from memory later.
--
-- WHAT THIS DOES NOT DO: create a login. Supabase auth users can only be
-- made from the Dashboard (Authentication -> Users -> Add user) or the admin
-- API, neither of which is reachable from SQL. Section 5 has the two
-- statements to run once the user exists.

-- ---------------------------------------------------------------------------
-- 1. Let `role` be 'partner' as well
-- ---------------------------------------------------------------------------
--
-- Unlike leads.source — which is deliberately unconstrained text, because
-- nothing branches on it (see claude/crm-lead-sources.md) — role IS branched
-- on, in src/components/capabilities.js and in AuthContext's isAdmin/isTech.
-- That makes it a state machine rather than a label, and by the same
-- reasoning that argues against constraining source, it argues FOR
-- constraining this: a typo'd role silently falls through to the fallback
-- and quietly grants the wrong access.
--
-- The cost is that adding a fourth role means editing three places: this
-- constraint, ALLOWED in capabilities.js, and the docs.

do $$
declare
  bad_roles text;
begin
  -- Refuse to add a constraint that existing rows would violate — that
  -- error, mid-migration, is far harder to read than this notice.
  select string_agg(distinct coalesce(role, '(null)'), ', ')
    into bad_roles
    from public.profiles
   where role is null or role not in ('admin', 'tech', 'partner');

  if bad_roles is not null then
    raise notice 'Not adding the role constraint: existing profiles hold %. Fix those rows, then re-run.', bad_roles;
  else
    alter table public.profiles drop constraint if exists profiles_role_check;
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('admin', 'tech', 'partner'));
    raise notice 'profiles.role now accepts admin, tech, partner.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Per-rep commission rates
-- ---------------------------------------------------------------------------
--
-- Stored as PERCENTS (10, 15, 20), not fractions (0.10). Both work; percents
-- win because these columns get edited by hand in the Supabase table editor,
-- and "15" is unambiguous there in a way "0.15" is not — nobody has ever
-- typed 15 meaning fifteen hundred percent, and people do type 0.15 meaning
-- fifteen hundredths of a percent. Anything computing money from these
-- divides by 100.
--
-- NULL means "use the house rate" from section 3 rather than "zero". That
-- distinction matters: a rep with no override should follow the standard
-- rate when it changes, while a rep explicitly set to 0 should stay at 0.

alter table public.profiles
  add column if not exists commission_find_rate numeric(5,2),
  -- Restricts the find override to ONE lead source.
  --
  -- Trenton's 15% was negotiated for the work he sees inside a house he is
  -- already in for Home Depot — it is the price of a warm, pre-qualified
  -- lead, not a blanket rate for anything he types into the CRM. Without
  -- this he earned 15% on a door knock too, which is a better rate than a
  -- tech gets for identical work.
  --
  -- NULL means the override applies to every source, which is the right
  -- default for an ordinary rep and preserves how this behaved before.
  add column if not exists commission_find_source text,
  add column if not exists commission_book_rate numeric(5,2),
  add column if not exists commission_work_rate numeric(5,2),
  add column if not exists commission_eligible boolean not null default true;

comment on column public.profiles.commission_find_rate is
  'Percent of the job earned for sourcing the lead. NULL = use sb_commission_find_rate().';
comment on column public.profiles.commission_find_source is
  'Restricts commission_find_rate to leads with this source. NULL = applies to every source.';
comment on column public.profiles.commission_book_rate is
  'Percent earned for moving the lead to booked. NULL = use sb_commission_book_rate().';
comment on column public.profiles.commission_work_rate is
  'Percent earned for working the job. NULL = use sb_commission_work_rate(). Paid per visit on recurring plans, unlike find and book which pay once.';
comment on column public.profiles.commission_eligible is
  'False for LLC members, who are paid as owners rather than on commission.';

-- Sanity bounds. A negative rate is a bug, and anything over 100 pays out
-- more than the job earned.
do $$
begin
  alter table public.profiles drop constraint if exists profiles_commission_rates_check;
  alter table public.profiles
    add constraint profiles_commission_rates_check
    check (
      coalesce(commission_find_rate, 0) between 0 and 100
      and coalesce(commission_book_rate, 0) between 0 and 100
      and coalesce(commission_work_rate, 0) between 0 and 100
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The house rates
-- ---------------------------------------------------------------------------
--
-- Functions rather than a settings table, matching the follow-up knobs in
-- db/follow-ups.sql (sb_follow_up_delay_days() and friends). Changing a rate
-- is then a `create or replace` you can read in the diff, and Phase 2's
-- earning logic can call them from inside the database — which it will need
-- to, since commissions will be stamped by a trigger on payment rather than
-- by the app.
--
-- 10 find + 10 book + 20 work = 40% of a job when three different people
-- each do one part, and the same 40% when one rep does all three. The
-- door-to-door "20%" is not a fourth rate; it is find and book earned in a
-- single conversation.

create or replace function public.sb_commission_find_rate()
returns numeric language sql immutable as $$ select 10::numeric $$;

create or replace function public.sb_commission_book_rate()
returns numeric language sql immutable as $$ select 10::numeric $$;

create or replace function public.sb_commission_work_rate()
returns numeric language sql immutable as $$ select 20::numeric $$;

-- The rate that actually applies to a person for a given kind of work.
-- Phase 2 will call this once per earning and then SNAPSHOT the answer onto
-- the ledger row — never read it live at report time, or raising someone's
-- rate would silently rewrite what they were owed last quarter.
-- Dropped and recreated rather than replaced: the signature gains a third
-- argument. The default keeps every existing two-argument call working —
-- book and work don't care what source a lead came from.
drop function if exists public.sb_commission_rate(uuid, text);

create or replace function public.sb_commission_rate(
  p_profile_id uuid,
  p_kind       text,
  p_source     text default null
)
returns numeric
language plpgsql
stable
as $$
declare
  eligible    boolean;
  override    numeric;
  only_source text;
begin
  select commission_eligible,
         case p_kind
           when 'find' then commission_find_rate
           when 'book' then commission_book_rate
           when 'work' then commission_work_rate
         end,
         commission_find_source
    into eligible, override, only_source
    from public.profiles
   where id = p_profile_id;

  -- No such profile, or an owner. Either way nothing is earned.
  if eligible is null or eligible = false then
    return 0;
  end if;

  -- A find override tied to one source only applies on that source.
  -- Everything else falls through to the house rate, so Trenton earns his
  -- negotiated 15% on a partner referral and the same 10% as anyone else
  -- on a door he knocked himself.
  if p_kind = 'find' and only_source is not null
     and p_source is distinct from only_source then
    override := null;
  end if;

  if override is not null then
    return override;
  end if;

  return case p_kind
    when 'find' then public.sb_commission_find_rate()
    when 'book' then public.sb_commission_book_rate()
    when 'work' then public.sb_commission_work_rate()
    else 0
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Owners earn no commission
-- ---------------------------------------------------------------------------
--
-- Seeded from role='admin' because today the only admins are Jordan and
-- Hayden, the two LLC members. That is a fact about right now, NOT a rule —
-- an admin who is an employee rather than a member should have this set back
-- to true by hand. The flag lives on the person precisely so it is a data
-- edit and not a list of names in the code.
--
-- Guarded so it only ever fires on a virgin database. Without the guard this
-- is a trap: an admin you had deliberately made eligible would be flipped
-- back to false the next time anyone re-ran the file, silently wiping out
-- their commission. Once any profile is ineligible, the seed is done and
-- never runs again.
--
-- (The guard is fooled if you make every admin eligible AND re-run — at
-- which point there are no false rows left to detect. Unlikely enough to
-- accept, and it fails toward not paying an owner rather than toward paying
-- someone twice.)

do $$
begin
  if exists (select 1 from public.profiles where commission_eligible = false) then
    raise notice 'Owner eligibility already seeded; leaving every profile as it is.';
  else
    update public.profiles
       set commission_eligible = false
     where role = 'admin';
    raise notice 'Seeded % owner(s) as commission-ineligible.', (
      select count(*) from public.profiles where role = 'admin'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Trenton, and the test profile
-- ---------------------------------------------------------------------------
--
-- Create the login first: Dashboard -> Authentication -> Users -> Add user.
-- Then run ONE of these, with the real values filled in.
--
-- A profiles row may already exist — Supabase projects commonly carry a
-- trigger that inserts one on signup — so both statements below update
-- rather than assuming they need to insert.

-- (a) The test profile, so you can log in as a partner and see exactly what
--     Trenton sees. Change the email to whichever one you just created.
--
-- update public.profiles
--    set role = 'partner',
--        full_name = 'Test Partner',
--        active = true,
--        commission_eligible = true,
--        commission_find_rate = 15,
--        commission_find_source = 'partner'
--  where id = (select id from auth.users where email = 'skybluecleaninggco@gmail.com');

-- (b) Trenton himself. 15% on finding, house rates on the rest — he works
--     jobs sometimes, so leaving work_rate NULL means he follows the
--     standard 20% without needing to be remembered separately.
--
-- update public.profiles
--    set role = 'partner',
--        full_name = 'Trenton <surname>',
--        active = true,
--        commission_eligible = true,
--        commission_find_rate = 15,
--        -- The 15% is for leads he spots on a Home Depot job. Anything else
--        -- he adds earns the house 10%, same as anyone.
--        commission_find_source = 'partner',
--        commission_book_rate = null,
--        commission_work_rate = null
--  where id = (select id from auth.users where email = '<trenton@example.com>');

-- ---------------------------------------------------------------------------
-- 6. What it looks like now
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  raise notice '--- profiles ---';
  for r in
    select full_name, role, active, commission_eligible,
           public.sb_commission_rate(id, 'find') as find_pct,
           public.sb_commission_rate(id, 'book') as book_pct,
           public.sb_commission_rate(id, 'work') as work_pct
      from public.profiles
     order by role, full_name
  loop
    -- Percent signs are left out of the format string on purpose: RAISE
    -- reads '%%' as a literal and '%' as a placeholder, so the obvious
    -- 'find=%%%' greedily matches the literal first and prints "%10".
    raise notice '% | % | active=% | eligible=% | rates find/book/work = %/%/%',
      coalesce(r.full_name, '(unnamed)'), r.role, r.active,
      r.commission_eligible, r.find_pct, r.book_pct, r.work_pct;
  end loop;
end;
$$;
