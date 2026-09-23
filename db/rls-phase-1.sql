-- db/rls-phase-1.sql
--
-- Row-level security, pass 1: shut the door on the public key.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Rollback: db/rls-phase-1-rollback.sql — keep that open in a second tab.
--
-- ===========================================================================
-- WHAT THIS FIXES
-- ===========================================================================
--
-- Every table a migration created already has RLS: quotes, commissions,
-- lead_events, job_events, contact_log, follow_ups, sms_messages,
-- sms_opt_outs. The five tables made by hand in the dashboard never got any:
--
--     leads, jobs, customers, profiles, job_assignments
--
-- With RLS off, PostgREST serves those tables to whoever holds a key that
-- has the grant — and Supabase grants `anon` by default. The anon key is
-- published in the website's JavaScript bundle. So this was not, as
-- capabilities.js claimed, "anyone with a login": every customer name,
-- address, phone number and job price was readable by anyone who opened
-- devtools on skybluecleaningco.com. That is the hole being closed.
--
-- ===========================================================================
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ===========================================================================
--
-- It does not change what a signed-in person can see. A tech and an owner
-- both still read every lead, job and customer, exactly as today. Narrowing
-- that is pass 2, and it needs every screen checked one by one, because a
-- policy that hides a row turns a working page into a blank one.
--
-- Two exceptions, both asked for and both cheap to get right:
--
--   * DELETE on leads, jobs and customers is owners only. Deletes cascade
--     into lead_events, job_events and payment records.
--   * role and the commission_* columns on profiles are owners only, so a
--     rep cannot raise their own rate or promote themselves by calling the
--     API directly. Money and access are the two things worth locking first.
--
-- Prices stay writable by any signed-in user, as requested — a rep recording
-- what was actually collected is normal work, not an exception.
--
-- ===========================================================================
-- THE ONE THING THAT COULD BREAK THE BUSINESS
-- ===========================================================================
--
-- The public website inserts leads with the ANON key:
--
--     src/lib/leadSubmit.js  ->  supabase.from("leads").insert(lead)
--
-- That is the only anonymous database call in either repo (checked). Turning
-- RLS on without an anon INSERT policy would silently kill every website
-- lead — the form would keep saying thank you, because submitLead treats the
-- Web3Forms email as success on its own, and nothing would reach the CRM.
--
-- Hence leads_public_insert below. Insert only: the public may hand us a
-- lead, and may not read one back.
--
-- ===========================================================================
-- WHAT IS UNAFFECTED
-- ===========================================================================
--
-- Netlify functions use the service key, which bypasses RLS entirely. Every
-- quote, receipt, text, follow-up and Square call keeps working untouched.
-- So do the SECURITY DEFINER triggers that write the history tables.

-- ---------------------------------------------------------------------------
-- 0. Refuse to run against a database that isn't this one
-- ---------------------------------------------------------------------------

do $$
declare
  missing text;
begin
  select string_agg(t, ', ')
    into missing
    from unnest(array['leads','jobs','customers','profiles','job_assignments']) t
   where to_regclass('public.' || t) is null;

  if missing is not null then
    raise exception 'Not running: these tables do not exist here — %', missing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who is asking?
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER matters more than it looks. These read `profiles`, which
-- this migration is about to put RLS on. An invoker-rights function would be
-- subject to that policy while being used BY that policy — the classic
-- infinite recursion that makes a table unreadable to everyone. Running as
-- the owner steps outside RLS and breaks the loop.
--
-- STABLE lets Postgres call it once per statement rather than once per row.
-- On a policy that is checked against every row of the leads table, that is
-- the difference between one lookup and thousands.

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

comment on function public.sb_is_admin() is
  'True when the signed-in user is an owner. SECURITY DEFINER so it can be
   used inside policies ON profiles without recursing.';

-- The signed-in person's role, or null when there is no session (the anon
-- key, or a server-side call with the service key).
--
-- Not used by any policy here — those ask sb_is_admin() directly, which is
-- cheaper and states its intent. This exists for the app and for reading
-- the database by hand: `select public.sb_role();` answers "who does the
-- database think I am?", which is the first question worth asking when a
-- screen comes back empty after a policy change.
create or replace function public.sb_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid()
$$;

comment on function public.sb_role() is
  'Role of the signed-in user, or NULL for anon/service-key callers.';

grant execute on function public.sb_is_admin() to authenticated;
grant execute on function public.sb_role() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. leads
-- ---------------------------------------------------------------------------
--
-- Policies are written out per table rather than generated in a loop. They
-- are nearly identical and a loop would be shorter, but this is the file
-- somebody reads when they are trying to work out why they can't see their
-- own data, and "read the loop and imagine the output" is a bad thing to ask
-- of that person.

alter table public.leads enable row level security;

drop policy if exists leads_staff_read on public.leads;
create policy leads_staff_read on public.leads
  for select to authenticated using (true);

drop policy if exists leads_staff_insert on public.leads;
create policy leads_staff_insert on public.leads
  for insert to authenticated with check (true);

drop policy if exists leads_staff_update on public.leads;
create policy leads_staff_update on public.leads
  for update to authenticated using (true) with check (true);

-- Owners only. A delete cascades into lead_events and can take jobs with it.
drop policy if exists leads_admin_delete on public.leads;
create policy leads_admin_delete on public.leads
  for delete to authenticated using (public.sb_is_admin());

-- The website's quote forms. INSERT only, and no `using` clause exists for
-- an insert policy, so this grants no way to read anything back.
drop policy if exists leads_public_insert on public.leads;
create policy leads_public_insert on public.leads
  for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- 3. jobs
-- ---------------------------------------------------------------------------

alter table public.jobs enable row level security;

drop policy if exists jobs_staff_read on public.jobs;
create policy jobs_staff_read on public.jobs
  for select to authenticated using (true);

drop policy if exists jobs_staff_insert on public.jobs;
create policy jobs_staff_insert on public.jobs
  for insert to authenticated with check (true);

-- Deliberately unrestricted: this is how a rep records what was collected,
-- reschedules, and marks a job complete.
drop policy if exists jobs_staff_update on public.jobs;
create policy jobs_staff_update on public.jobs
  for update to authenticated using (true) with check (true);

drop policy if exists jobs_admin_delete on public.jobs;
create policy jobs_admin_delete on public.jobs
  for delete to authenticated using (public.sb_is_admin());

-- ---------------------------------------------------------------------------
-- 4. customers
-- ---------------------------------------------------------------------------

alter table public.customers enable row level security;

drop policy if exists customers_staff_read on public.customers;
create policy customers_staff_read on public.customers
  for select to authenticated using (true);

drop policy if exists customers_staff_insert on public.customers;
create policy customers_staff_insert on public.customers
  for insert to authenticated with check (true);

drop policy if exists customers_staff_update on public.customers;
create policy customers_staff_update on public.customers
  for update to authenticated using (true) with check (true);

drop policy if exists customers_admin_delete on public.customers;
create policy customers_admin_delete on public.customers
  for delete to authenticated using (public.sb_is_admin());

-- ---------------------------------------------------------------------------
-- 5. job_assignments
-- ---------------------------------------------------------------------------
--
-- Delete is NOT owners-only here, unlike the three above. Removing an
-- assignment is unassigning somebody from a job — ordinary scheduling, not
-- destruction, and it leaves its own trail through the commission triggers.
-- Locking it would break reassigning a job on a day somebody called in sick.

alter table public.job_assignments enable row level security;

drop policy if exists job_assignments_staff_read on public.job_assignments;
create policy job_assignments_staff_read on public.job_assignments
  for select to authenticated using (true);

drop policy if exists job_assignments_staff_write on public.job_assignments;
create policy job_assignments_staff_write on public.job_assignments
  for insert to authenticated with check (true);

drop policy if exists job_assignments_staff_update on public.job_assignments;
create policy job_assignments_staff_update on public.job_assignments
  for update to authenticated using (true) with check (true);

drop policy if exists job_assignments_staff_delete on public.job_assignments;
create policy job_assignments_staff_delete on public.job_assignments
  for delete to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 6. profiles
-- ---------------------------------------------------------------------------
--
-- Readable by everyone signed in, and it has to be: the CRM embeds the
-- actor's name all over the place — `actor:changed_by ( full_name )` in the
-- job and lead histories, the sender on a quote, who took a payment. Hiding
-- other people's rows would empty every one of those.
--
-- Writable only to yourself, or by an owner.

alter table public.profiles enable row level security;

drop policy if exists profiles_staff_read on public.profiles;
create policy profiles_staff_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_self_or_admin_update on public.profiles;
create policy profiles_self_or_admin_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.sb_is_admin())
  with check (id = auth.uid() or public.sb_is_admin());

-- Belt and braces. A new profile normally appears via a SECURITY DEFINER
-- trigger on auth.users, which bypasses RLS — but if that trigger was ever
-- created without it, signing up a user would start failing the moment RLS
-- came on, and the error would point at the trigger rather than at here.
drop policy if exists profiles_self_insert on public.profiles;
create policy profiles_self_insert on public.profiles
  for insert to authenticated
  with check (id = auth.uid() or public.sb_is_admin());

-- No delete policy at all: nothing in the app deletes a profile, and a
-- deleted profile orphans history rows that reference it.

-- ---------------------------------------------------------------------------
-- 7. The columns a rep must not be able to change on their own row
-- ---------------------------------------------------------------------------
--
-- The policy above lets somebody edit their own profile. That has to stay —
-- but "your own profile" includes the two fields that decide what you are
-- paid and what you are allowed to do. Without this, a rep could POST
-- {"role":"admin"} to their own row and be an owner a second later.
--
-- RLS cannot express "these columns, no" — it works on rows. Column GRANTs
-- could, but they need every other column of profiles listed by name, and a
-- column added later would silently become unwritable. A trigger states the
-- rule directly and says so in words when it fires.

create or replace function public.sb_guard_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  -- No session: the service key, or the SQL editor. Both are already
  -- trusted — the service key never reaches a browser, and anyone in the
  -- SQL editor owns the database anyway.
  --
  -- This is not a hole for the anon key, which also has no auth.uid():
  -- anon has no UPDATE policy on profiles, so RLS refuses the statement
  -- before this trigger is ever reached.
  if auth.uid() is null then
    return new;
  end if;

  if public.sb_is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'Only an owner can change a role.'
      using errcode = '42501';
  end if;

  if new.commission_eligible    is distinct from old.commission_eligible
     or new.commission_find_rate   is distinct from old.commission_find_rate
     or new.commission_find_source is distinct from old.commission_find_source
     or new.commission_book_rate   is distinct from old.commission_book_rate
     or new.commission_work_rate   is distinct from old.commission_work_rate
  then
    raise exception 'Only an owner can change commission rates.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.sb_guard_profile_privileges() is
  'Blocks a non-owner changing role or any commission_* column, including on
   their own profile row. 42501 so PostgREST answers 403.';

drop trigger if exists profiles_guard_privileges on public.profiles;
create trigger profiles_guard_privileges
  before update on public.profiles
  for each row
  execute function public.sb_guard_profile_privileges();

-- ---------------------------------------------------------------------------
-- 8. What it looks like now
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  open_tables text;
begin
  raise notice '';
  raise notice 'Row-level security is now ON for:';
  for r in
    select c.relname, count(p.policyname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p
        on p.schemaname = 'public' and p.tablename = c.relname
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity
     group by c.relname
     order by c.relname
  loop
    raise notice '  % (% policies)', rpad(r.relname, 22), r.policies;
  end loop;

  select string_agg(c.relname, ', ' order by c.relname)
    into open_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  raise notice '';
  if open_tables is null then
    raise notice 'No table in public is left without RLS.';
  else
    raise notice 'STILL OPEN (no RLS): %', open_tables;
    raise notice 'Check whether any of those hold customer data.';
  end if;
  raise notice '';
  raise notice 'Rollback if anything breaks: db/rls-phase-1-rollback.sql';
end;
$$;
