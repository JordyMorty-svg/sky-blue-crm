-- db/lead-event-dedupe.sql
--
-- "New → Contacted", "Contacted → New", "New → Contacted" — three status
-- rows in the same minute, under one call.
--
-- Run after db/quotes.sql and db/call-tracking.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS ON SCREEN
-- ---------------------------------------------------------------------------
--
-- Kristina's timeline, 12 October, all at 3:23 PM:
--
--     Called · New → Contacted      (no actor)
--     New → Contacted               (no actor)
--     Contacted → New               Jordan
--     New → Contacted               (no actor)
--
-- Three separate faults, stacked. Only the first two are this file's.
--
-- ---------------------------------------------------------------------------
-- 1. THE DUPLICATE — rows one and two
-- ---------------------------------------------------------------------------
--
-- db/contact-history.sql set out to stop exactly this:
--
--     When a call advanced the lead (new -> contacted), the move is
--     recorded HERE rather than left to lead_events. Otherwise the
--     timeline has to either drop the transition or show the call twice
--     — once as outreach and once as a status change a second apart.
--
-- The move does get recorded on the contact_log row: that is where
-- "Called · New → Contacted" comes from. But nothing ever stopped
-- lead_events ALSO recording it. record_contact_as() updates leads.status,
-- which fires log_lead_status_change(), which writes its own row — and
-- contact_timeline() shows both. The exclusion it does have,
-- `coalesce(le.kind, 'status') <> 'call'`, drops the OLD click-logged call
-- events. It does not touch a status row.
--
-- Half of a fix, for two years, and the symptom only became obvious once
-- calls started arriving by webhook often enough to notice the pairs.
--
-- The fix is a transaction-local flag set around that one UPDATE. Exact,
-- rather than a time-window dedupe in the timeline: "a lead_events row
-- within five seconds of a matching contact_log row" is a rule that will
-- one day eat a real status change somebody made while a call was landing.
--
-- NOT APPLIED TO refresh_call_detail(). That function also advances a lead
-- — when a transcript finally reports a duration for a call that looked
-- unanswered — and its move is NOT written on any contact_log row, because
-- the row was already written as an attempt. There, the lead_events row is
-- the only record there is.
--
-- ---------------------------------------------------------------------------
-- 2. "Contacted → New" — row three, and NOT a database bug
-- ---------------------------------------------------------------------------
--
-- That one is the lead edit form. Its save payload is an explicit column
-- list that includes `status: draft.status`, and `draft` falls back to the
-- lead as it was WHEN THE PAGE LOADED. The page was open from before the
-- call; the webhook moved her to Contacted; pressing Save wrote the stale
-- `new` back over it.
--
-- Fixed in src/pages/leads/LeadDetail.jsx, which now omits status from the
-- payload unless somebody actually chose one. Mentioned here because the
-- three rows look like one bug and are not, and because row four —
-- refresh_call_detail re-advancing her when the summary arrived — only
-- exists because row three put her back.
--
-- ---------------------------------------------------------------------------


do $$
begin
  if to_regprocedure('public.record_contact_as(uuid, uuid, uuid, text, text, text, text, integer, text, boolean, timestamptz)') is null then
    raise exception 'Run db/call-tracking.sql before this file.';
  end if;
  if to_regclass('public.lead_events') is null then
    raise exception 'Run db/lead-events.sql before this file.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 1. The trigger learns to be told to keep quiet
-- ---------------------------------------------------------------------------
--
-- RESTATED FROM db/quotes.sql, not db/lead-events.sql. Both define this
-- trigger and quotes.sql runs later and wins — it added the `sb.actor`
-- setting that lets sb_accept_quote() say who accepted a quote when there
-- is no session user. Copying the older body would silently drop that, and
-- every quote accepted from the public link would lose its name.
--
-- The addition here is the first block: one more setting, read the same way
-- and with the same posture — a malformed value must never be able to stop
-- a status change going through.

create or replace function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor    uuid;
  claimed  uuid;
  quiet    boolean;
begin
  -- ALREADY RECORDED ELSEWHERE. record_contact_as() sets this around its
  -- own update to leads, because the move is written on the contact_log
  -- row it just inserted and a second bare row is the duplicate this file
  -- exists to remove.
  begin
    quiet := coalesce(current_setting('sb.skip_lead_event', true), 'off') = 'on';
  exception when others then
    quiet := false;
  end;

  if quiet and tg_op = 'UPDATE' then
    return new;
  end if;

  -- An explicitly claimed actor (set by sb_accept_quote), else the session.
  begin
    claimed := nullif(current_setting('sb.actor', true), '')::uuid;
  exception when others then
    -- A malformed setting must never block a status change. History is
    -- allowed to be incomplete; the CRM is not allowed to stop working.
    claimed := null;
  end;

  select p.id into actor
    from public.profiles p
   where p.id = coalesce(claimed, auth.uid());

  if tg_op = 'INSERT' then
    -- NEVER SUPPRESSED, whatever the flag says. "Added as a lead" is the
    -- first row of every timeline and nothing else writes it. A flag left
    -- on by mistake must not be able to produce a lead with no beginning.
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, actor);
    return new;
  end if;

  -- Only log real transitions. Saving the lead detail form rewrites every
  -- column, so without this guard every edit would create a noise event.
  if new.status is distinct from old.status then
    insert into public.lead_events (lead_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, actor);
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. The one update that sets it
-- ---------------------------------------------------------------------------
--
-- RESTATED FROM db/call-tracking.sql, which is the current definition —
-- db/contact-history.sql has an older one without the call columns.
-- Everything but the two set_config lines is unchanged, and
-- verify/lead-event-dedupe.sql diffs the installed copy against this
-- intent so a later edit to call-tracking.sql cannot quietly win.

create or replace function public.record_contact_as(
  p_actor       uuid,
  p_lead_id     uuid default null,
  p_customer_id uuid default null,
  p_kind        text default 'call',
  p_detail      text default null,
  -- The new, all optional, all defaulted so the old call shape still means
  -- exactly what it meant.
  p_direction        text    default null,
  p_outcome          text    default null,
  p_duration_seconds integer default null,
  p_provider_call_id text    default null,
  -- Did we actually reach them? Null means "this is not a call, don't ask" —
  -- which is the right answer for an email, a note, or a text.
  --
  -- THE ONE ARGUMENT THAT MATTERS. It is what decides whether a new lead
  -- moves to contacted, and separating it from p_kind is the whole point of
  -- this file: a call that rang out is still a call, and used to be
  -- indistinguishable from one where somebody answered.
  p_reached          boolean default null,
  p_at               timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  ident   record;
  lead_out uuid;
  cust_out uuid;
  new_id  bigint;
  was     text;
  becomes text;
  -- An inbound call is not outreach. It should appear on the timeline and
  -- it should not inflate the number somebody reads as "how many times have
  -- we chased this person".
  outbound boolean := coalesce(p_direction, 'out') <> 'in';
  -- Null (not a call) keeps the old behaviour: an email or a note counts as
  -- having reached out, because sending it is the whole act.
  reached  boolean := coalesce(p_reached, true);
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  lead_out := coalesce(p_lead_id, (select x from unnest(ident.lead_ids) x limit 1));
  cust_out := coalesce(p_customer_id, (select x from unnest(ident.customer_ids) x limit 1));

  -- Read the status before the update below so the move can be recorded.
  --
  -- Gated on `reached`, which is the fix. A lead only advances when
  -- somebody actually spoke to them — ringing out three times leaves them
  -- on New, which is where they belong and where the board will keep
  -- showing them until somebody gets through.
  if lead_out is not null and reached then
    select status into was from public.leads where id = lead_out;
    becomes := case when was = 'new' then 'contacted' else null end;
  end if;

  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, from_status, to_status, detail,
    changed_by, provider_call_id, direction, outcome, duration_seconds, created_at
  )
  values (
    lead_out, cust_out, ident.phone, coalesce(p_kind, 'call'),
    case when becomes is not null then was else null end,
    becomes, p_detail, p_actor,
    p_provider_call_id, p_direction, p_outcome, p_duration_seconds,
    -- Quo's timestamp when it gave us one. A webhook retried twenty minutes
    -- later must not put the call twenty minutes after it happened.
    coalesce(p_at, now())
  )
  -- The retry guard. Second delivery of the same call changes nothing and
  -- returns nothing, so the caller can tell a new call from a repeat.
  on conflict (provider_call_id) where provider_call_id is not null
    do nothing
  returning id into new_id;

  if new_id is null then
    return null;
  end if;

  if lead_out is not null then
    -- THE MOVE IS ALREADY WRITTEN, on the contact_log row inserted above.
    -- This flag stops log_lead_status_change() writing it a SECOND time as
    -- a bare lead_events row. See db/lead-event-dedupe.sql.
    --
    -- Transaction-local (the `true`), so it cannot leak into the next
    -- statement on a pooled connection — which is the failure mode that
    -- would make a real status change vanish from the history.
    perform set_config('sb.skip_lead_event', 'on', true);

    update public.leads
    set last_contacted_at = case when outbound then coalesce(p_at, now())
                                 else last_contacted_at end,
        contact_attempts  = coalesce(contact_attempts, 0)
                            + case when outbound then 1 else 0 end,
        status = case when status = 'new' and reached then 'contacted' else status end
    where id = lead_out;

    -- Cleared immediately, not left for the transaction to end. A webhook
    -- that records a contact and then does anything else to the lead must
    -- have that second change logged normally.
    perform set_config('sb.skip_lead_event', 'off', true);
  end if;

  if cust_out is not null then
    update public.customers
    set last_contacted_at = case when outbound then coalesce(p_at, now())
                                 else last_contacted_at end,
        contact_attempts  = coalesce(contact_attempts, 0)
                            + case when outbound then 1 else 0 end
    where id = cust_out;
  end if;

  return new_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3. The pairs already in the table
-- ---------------------------------------------------------------------------
--
-- Offered, not run. Every duplicate written before today is still there,
-- and deleting history is not something a migration should do on its own
-- while somebody is reading the page it is deleting from.
--
-- Call it by hand when you have looked at what it would take:
--     select * from public.duplicate_status_events;
--     select public.sb_purge_duplicate_status_events();

create or replace view public.duplicate_status_events as
  select
    le.id,
    le.lead_id,
    le.from_status,
    le.to_status,
    le.created_at
  from public.lead_events le
  where coalesce(le.kind, 'status') = 'status'
    -- NO `from_status is not null` GUARD, deliberately. A creation event
    -- has a null from_status, and `cl.from_status = le.from_status` is
    -- NULL rather than true against it, so it can never match — the guard
    -- would be a condition that cannot fail, which is a condition nobody
    -- can reason about. The protection is the equality below, and
    -- verify/lead-event-dedupe.sql holds it there.
    --
    -- A contact_log row for the same lead carrying the SAME move. Not "a
    -- contact at about the same time": the from/to pair has to match, or
    -- this would eat a genuine status change somebody made by hand while a
    -- call happened to be landing.
    and exists (
      select 1 from public.contact_log cl
      where cl.lead_id = le.lead_id
        and cl.from_status = le.from_status
        and cl.to_status   = le.to_status
        -- Written by the same action, so within seconds. Wide enough for a
        -- slow transaction, narrow enough that the same move made again an
        -- hour later is its own event.
        and cl.created_at between le.created_at - interval '10 seconds'
                              and le.created_at + interval '10 seconds'
    );

comment on view public.duplicate_status_events is
  'lead_events status rows that duplicate a move already recorded on a
   contact_log row. Written before db/lead-event-dedupe.sql.';

create or replace function public.sb_purge_duplicate_status_events()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  gone int;
begin
  delete from public.lead_events le
  using public.duplicate_status_events d
  where le.id = d.id;
  get diagnostics gone = row_count;
  return gone;
end;
$$;

revoke all on function public.sb_purge_duplicate_status_events() from public;
grant execute on function public.sb_purge_duplicate_status_events() to service_role;


-- ---------------------------------------------------------------------------
-- 4. How many are in there
-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  select count(*) into n from public.duplicate_status_events;
  raise notice 'duplicate status events: % (run select public.sb_purge_duplicate_status_events() to remove them)', n;
end;
$$;
