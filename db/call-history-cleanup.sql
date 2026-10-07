-- Sky Blue CRM — removing the calls that were never calls
--
-- Run AFTER db/call-tracking.sql. Safe to run before or after
-- db/call-outcome.sql; it touches no function either of them defines.
--
-- WHAT THIS IS FOR
-- ----------------
-- Until db/call-tracking.sql, pressing Call wrote a row before anything had
-- happened. On a desktop, where the handoff opens nothing at all, every
-- press became a call in somebody's history. Six of them are sitting on one
-- test lead; there will be more on the real ones.
--
-- Those rows are indistinguishable from real history by eye — "Called",
-- a timestamp, a name — and they are counted in `contact_attempts`, which
-- is the number the follow-up automation reads and the number a person
-- reads before deciding whether to chase somebody again.
--
-- NOTHING IS DELETED BY DEFAULT. purge_click_logged_calls() takes a cutoff
-- and a p_apply flag, and with p_apply left alone it counts and returns.
-- Look at click_logged_calls() first; it lists exactly what the purge would
-- take.
--
-- WHY A CUTOFF RATHER THAN A RULE
-- -------------------------------
-- The obvious rule — "a call row with no provider_call_id was not written by
-- Quo" — is almost right and would delete real history. The Log a contact
-- form on the history page still writes exactly that shape, on purpose, for
-- a call somebody had on their own phone and wants recorded. There is no
-- field that separates those from the button presses.
--
-- What does separate them is time: the button stopped writing when the fix
-- deployed. So the cutoff is the deploy, it is passed in rather than
-- guessed, and anything after it is left alone.

do $$
begin
  if to_regclass('public.contact_log') is null then
    raise exception 'Run db/contact-history.sql and db/call-tracking.sql first.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contact_log'
       and column_name = 'provider_call_id'
  ) then
    raise exception 'Run db/call-tracking.sql first — this needs provider_call_id.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Look before you delete
-- ---------------------------------------------------------------------------
--
--   select * from public.click_logged_calls('2026-10-07T00:00:00Z');
--
create or replace function public.click_logged_calls(p_before timestamptz)
returns table (
  id          bigint,
  happened_at timestamptz,
  kind        text,
  detail      text,
  lead_id     uuid,
  customer_id uuid,
  changed_by  uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select cl.id, cl.created_at, cl.kind, cl.detail,
         cl.lead_id, cl.customer_id, cl.changed_by
    from public.contact_log cl
   where cl.kind in ('call', 'call_attempt', 'call_in', 'call_missed')
     -- Quo's id. A row that has one came from the webhook, which only ever
     -- writes a call that Quo says took place.
     and cl.provider_call_id is null
     and cl.created_at < p_before
   order by cl.created_at
$$;

comment on function public.click_logged_calls(timestamptz) is
  'The call rows written by the old log-on-click button: no Quo id, before
   the cutoff. Read this before running purge_click_logged_calls().';

-- ---------------------------------------------------------------------------
-- 2. The purge
-- ---------------------------------------------------------------------------
--
--   select * from public.purge_click_logged_calls('2026-10-07T00:00:00Z');
--      -- counts, deletes nothing
--   select * from public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);
--      -- deletes
--
create or replace function public.purge_click_logged_calls(
  p_before timestamptz,
  p_apply  boolean default false
)
returns table (rows_removed bigint, leads_adjusted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  n_rows    bigint;
  n_leads   bigint;
  out_leads uuid[];
  touched   uuid[];
begin
  if not p_apply then
    -- A dry run is the default because this cannot be undone, and because
    -- "I'll just see what it says" is what somebody types at eleven at
    -- night. Returns the same two numbers the real run will.
    select count(*), count(distinct lead_id)
      into n_rows, n_leads
      from public.click_logged_calls(p_before);
    return query select coalesce(n_rows, 0), coalesce(n_leads, 0);
    return;
  end if;

  -- TWO STATEMENTS, NOT ONE, and the reason is worth keeping.
  --
  -- A single statement with CTEs would be neater, and last_contacted_at
  -- would come out wrong: every CTE in one statement reads the same snapshot,
  -- so a max() over contact_log inside it would still see the rows this
  -- statement is deleting. The recompute has to run after the delete has
  -- landed.
  with doomed as (
    select id from public.click_logged_calls(p_before)
  ), gone as (
    delete from public.contact_log cl
     using doomed d
     where cl.id = d.id
    returning cl.id, cl.lead_id, cl.direction
  )
  select count(*),
         count(distinct lead_id),
         -- One entry per deleted OUTGOING row, so the counter can be given
         -- back exactly what those rows added.
         coalesce(array_agg(lead_id) filter (
           where lead_id is not null and coalesce(direction, 'out') <> 'in'
         ), '{}'),
         coalesce(array_agg(distinct lead_id) filter (where lead_id is not null), '{}')
    into n_rows, n_leads, out_leads, touched
    from gone;

  -- DECREMENTED, NOT RECOUNTED.
  --
  -- Recomputing contact_attempts from what is left would be tidier and
  -- wrong: it assumes every row in contact_log went through
  -- record_contact_as() and incremented the counter, and a status change
  -- writes a row here too. Taking back exactly what the deleted rows added
  -- needs no such assumption.
  --
  -- An inbound call never incremented it, so it is not decremented either —
  -- the same `direction <> 'in'` test record_contact_as() uses.
  update public.leads l
     set contact_attempts = greatest(0, coalesce(l.contact_attempts, 0) - d.n)
    from (select u as lead_id, count(*) as n from unnest(out_leads) u group by u) d
   where l.id = d.lead_id;

  -- last_contacted_at CAN be recomputed, because it is a max over rows that
  -- are still there rather than a running total. A lead whose only outreach
  -- was a button press goes back to null, which is the truth: nobody has
  -- reached out.
  update public.leads l
     set last_contacted_at = (
           select max(c.created_at)
             from public.contact_log c
            where c.lead_id = l.id
              and coalesce(c.direction, 'out') <> 'in'
         )
   where l.id = any(touched);

  return query select coalesce(n_rows, 0), coalesce(n_leads, 0);
end;
$$;

revoke all on function public.purge_click_logged_calls(timestamptz, boolean)
  from public, anon, authenticated;

comment on function public.purge_click_logged_calls(timestamptz, boolean) is
  'Deletes the call rows the old log-on-click button wrote before the cutoff
   and takes their contribution back out of leads.contact_attempts. Counts
   only unless p_apply is true.';
