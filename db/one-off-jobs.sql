-- Sky Blue CRM — one-off jobs for customers who are on a plan
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- THE BUG THIS FIXES
--
-- Booking an extra job for a Quarterly customer — a touch-up, a callout, a
-- storm cleanup — corrupted their recurring cycle three different ways:
--
--   1. The extra took the next visit_number in the chain, so a customer on
--      their 2nd plan visit suddenly showed "visit 3", and every following
--      visit was misnumbered. Discounts key off that number.
--   2. Completing the extra generated another 'upcoming' visit, so pending
--      visits piled up: three completed jobs, three visits due.
--   3. ensureNextVisit re-stamped the extra with the customer's plan,
--      writing a "One-time -> Quarterly" event onto a job that was never
--      meant to be a plan visit at all.
--
-- WHY A COLUMN AND NOT A CONVENTION
--
-- service_plan = 'one_time' on a job already means something specific and
-- DIFFERENT: "booked before this customer signed up". ensureNextVisit
-- deliberately re-stamps those, because a visit completed the week before
-- someone joins the plan genuinely is their first plan visit.
--
-- "This is an extra and must never touch the cycle" is a second, unrelated
-- fact. Overloading one_time to mean both is what broke it — the code
-- cannot tell them apart, so it guesses, and it guessed wrong. This column
-- says which is which, out loud.

alter table public.jobs
  add column if not exists is_extra boolean not null default false;

comment on column public.jobs.is_extra is
  'True for a one-off job booked outside the recurring cycle (touch-up,
   callout, extra clean). Never advances visit_number, never generates a
   next visit, and is never adopted as the anchor for one. False for both
   plan visits and ordinary jobs booked before a customer joined a plan.';

-- ensureNextVisit looks for "the customer''s most recent completed job that
-- is not an extra". This is that lookup.
create index if not exists jobs_customer_plan_anchor_idx
  on public.jobs (customer_id, starts_at desc)
  where is_extra = false;

-- ---------------------------------------------------------------------------
-- Diagnostic: what does each recurring customer''s chain look like now?
-- ---------------------------------------------------------------------------
--
-- Read-only. Existing rows are NOT repaired automatically: visit numbers
-- that are already wrong can only be corrected by someone who knows which
-- of those jobs was meant to be an extra, and a migration guessing at that
-- is how the data got tangled in the first place.
--
-- What to look for:
--   * more than one row with status 'upcoming' for a customer — duplicates
--     from the old behaviour; delete all but the soonest.
--   * gaps in visit_number (1, 3, 5) — the missing numbers were consumed by
--     extras. Harmless once fixed, but renumber if it bothers you.

select
  c.name                                        as customer,
  c.service_plan                                as plan,
  j.visit_number                                as visit,
  j.is_extra                                    as extra,
  j.status,
  j.starts_at::date                             as job_date,
  coalesce(j.final_price, j.price)              as amount
from public.customers c
join public.jobs j on j.customer_id = c.id
where c.service_plan <> 'one_time'
order by c.name, j.starts_at nulls last;
