-- db/orphan-calls.sql
--
-- Calls to people who are not in the CRM yet.
--
-- Run after db/call-tracking.sql. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
--
-- You ring somebody back from the Quo app. Twenty minutes later you decide
-- they are worth entering, and you add them as a lead. Their page says
-- "Nobody has reached out yet", because record_quo_call() looked the number
-- up when the webhook arrived, found nobody, and did this:
--
--     if who.lead_id is null and who.customer_id is null then
--       -- A number nobody in the CRM owns: a supplier, a wrong number,
--       -- Hayden's mother. Not an error and not worth a row.
--       return null;
--
-- That reasoning is sound for a supplier and wrong for a customer, and at
-- the moment the webhook fires there is no way to tell which one you have.
-- The information arrives later — when somebody types the number into a
-- lead form.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO HOLDING TABLE
-- ---------------------------------------------------------------------------
--
-- The obvious design is a staging table of unmatched calls plus a job that
-- adopts them when a matching lead appears. None of that is needed, because
-- contact_log was built for this on day one:
--
--     lead_id     uuid ...   -- Both nullable, both stamped when known.
--     customer_id uuid ...   -- A row with only a phone still finds its
--     phone_norm  text       -- way home.
--
-- and contact_timeline() already reads all three:
--
--     where cl.lead_id = any(ident.lead_ids)
--        or cl.customer_id = any(ident.customer_ids)
--        or (ident.phone is not null and cl.phone_norm = ident.phone)
--
-- So a call written with a phone and no ids is invisible until somebody with
-- that number exists, and visible the instant one does. No adoption step, no
-- second table, no job that can fall behind. The only change this file makes
-- to the write path is deleting an early return.
--
-- ---------------------------------------------------------------------------
-- AND WHY THERE IS A SWEEP
-- ---------------------------------------------------------------------------
--
-- The comment that early return carried was not wrong, it was just early.
-- Keeping every call to every number forever does put the supplier and the
-- wrong number and Hayden's mother in this table permanently. Section 3
-- deletes unmatched call rows after 90 days — long enough that anybody you
-- rang before entering them still arrives with their history, short enough
-- that the table does not become a log of every call this business makes.
--
-- The guard that matters is that the sweep skips any row whose number now
-- belongs to somebody. Those rows are not orphans any more; they are
-- somebody's history, visible on their page, and deleting them would be
-- erasing a call that is currently on screen.


-- ---------------------------------------------------------------------------
-- 1. Write the call even when nobody owns the number
-- ---------------------------------------------------------------------------
--
-- Everything above the identity lookup is unchanged from db/call-tracking.sql
-- and is repeated here in full, because `create or replace function` replaces
-- the whole body and a partial copy is a silently reverted bug fix.

-- RUN db/call-outcome.sql FIRST. Checked rather than assumed, because the
-- failure if it has not is not an error: this file would install a
-- record_quo_call built on sb_call_connected(text, integer, boolean) and
-- sb_call_phrase(), both of which that file creates, and the function would
-- compile fine and throw at the first webhook.
do $$
begin
  if to_regprocedure('public.sb_call_phrase(boolean, boolean, boolean, integer)') is null
     or to_regprocedure('public.sb_call_connected(text, integer, boolean)') is null then
    raise exception
      'Run db/call-tracking.sql, db/call-notes.sql and db/call-outcome.sql before this file.';
  end if;
end $$;

-- REBASED ONTO db/call-outcome.sql, NOT db/call-tracking.sql.
--
-- Both of those define record_quo_call and call-outcome.sql runs later and
-- wins — it added a p_answered argument, the three-argument
-- sb_call_connected(), sb_call_phrase() for the wording, and the inverted
-- `not_a_call` gate that keeps an abandoned INBOUND call (a lead who gave up
-- waiting, the most worth knowing of the lot) while still dropping an
-- abandoned outbound one.
--
-- The first draft of this file copied the older six-argument body. Run in
-- order, it would have created a second overload beside the seven-argument
-- one rather than replacing it, and quietly undone all four of those
-- changes. The drop below is what stops the overload; being rebased is what
-- stops the rest. Anything edited in call-outcome.sql has to be carried
-- across to here as well — which is the price of restating a function, and
-- why verify/orphan-calls.sql diffs the installed copy.

drop function if exists public.record_quo_call(
  text, text, text, text, integer, timestamptz);

create or replace function public.record_quo_call(
  p_call_id   text,
  p_phone     text,
  p_direction text,
  p_status    text,
  p_duration  integer     default null,
  p_at        timestamptz default null,
  p_answered  boolean     default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  who       record;
  status    text    := lower(coalesce(p_status, ''));
  inbound   boolean := lower(coalesce(p_direction, '')) in ('in', 'incoming', 'inbound');
  connected boolean := public.sb_call_connected(p_status, p_duration, p_answered);
  -- THE INVERTED GATE, from db/call-outcome.sql. Everything not named here
  -- is written down. `abandoned` depends on direction: outbound it is
  -- somebody pressing call and hanging up before it rang, inbound it is a
  -- caller who gave up waiting.
  not_a_call boolean := status in ('failed', 'unknown', 'ai-handled', 'ai_handled')
                        or (status = 'abandoned' and not inbound);
  answered_fact boolean := coalesce(p_answered,
                             case when status in ('answered', 'forwarded') then true end);
  kind_out   text;
  detail_out text;
  new_id     bigint;
begin
  if coalesce(btrim(p_call_id), '') = '' then
    -- No id means no dedupe, and no dedupe means Quo's retries write the
    -- same call over and over.
    return null;
  end if;

  if not_a_call then
    return null;
  end if;

  kind_out := case
                when connected and inbound then 'call_in'
                when connected             then 'call'
                when inbound               then 'call_missed'
                else                            'call_attempt'
              end;

  detail_out := public.sb_call_phrase(connected, inbound, answered_fact, p_duration);

  select * into who from public.sb_contact_for_phone(p_phone);

  if who.lead_id is not null or who.customer_id is not null then
    -- Somebody owns this number. Unchanged path: record_contact_as resolves
    -- the whole identity, bumps the counters and moves the lead's status.
    return public.record_contact_as(
      null,            -- Quo placed it; no profile in this database did.
      who.lead_id,
      who.customer_id,
      kind_out,
      detail_out,
      case when inbound then 'in' else 'out' end,
      status,
      p_duration,
      p_call_id,
      connected,
      p_at
    );
  end if;

  -- NOBODY OWNS IT YET. Written anyway, with the phone and nothing else.
  --
  -- NOT THROUGH record_contact_as(), and this is deliberate rather than
  -- duplication for its own sake. That function's whole job is the three
  -- things an orphan row must not do: resolve an identity (there is none),
  -- bump last_contacted_at and contact_attempts on a row (there is no row),
  -- and move a lead from New to Contacted (there is no lead). Calling it
  -- with nulls would do none of them, which is correct, but it would also
  -- write ident.phone — null, because identity resolution is what produces
  -- it — and a row with no ids AND no phone can never find its way home.
  --
  -- NO COUNTERS, therefore. When this person becomes a lead their
  -- contact_attempts starts at 0 while their timeline already shows a call.
  -- That disagreement is real, and it is fixed where it belongs: the call
  -- bar now counts the timeline instead of reading the column. See
  -- outreachFrom() in src/services/contactFilters.js.
  insert into public.contact_log (
    lead_id, customer_id, phone_norm, kind, detail,
    provider_call_id, direction, outcome, duration_seconds, created_at
  )
  values (
    null, null, public.sb_phone_digits(p_phone), kind_out, detail_out,
    p_call_id, case when inbound then 'in' else 'out' end, status, p_duration,
    coalesce(p_at, now())
  )
  -- The same retry guard as the matched path. Quo redelivers anything that
  -- is not a 2xx, and without this an orphan call would be written once per
  -- retry.
  on conflict (provider_call_id) where provider_call_id is not null
    do nothing
  returning id into new_id;

  return new_id;
exception
  when others then
    -- Same posture as db/call-outcome.sql: a webhook that 500s is a webhook
    -- Quo retries forever. Swallow, log, move on.
    raise warning 'record_quo_call failed for % : %', p_call_id, sqlerrm;
    return null;
end;
$$;

revoke all on function public.record_quo_call(
  text, text, text, text, integer, timestamptz, boolean) from public, anon, authenticated;

comment on function public.record_quo_call(
  text, text, text, text, integer, timestamptz, boolean) is
  'Writes one row of call history from a Quo call.completed webhook, unless
   the status says no call took place. A number nobody owns yet is recorded
   against the phone alone and surfaces automatically when a lead or customer
   with that number is created. See db/orphan-calls.sql.';


-- ---------------------------------------------------------------------------
-- 2. The join that makes section 1 work at all
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS, EVERYTHING ABOVE IS DEAD CODE, silently. db/call-tracking.sql
-- left a note saying so, two years before there was anything to break:
--
--     MATCHING changes; the RETURNED phone does not. contact_log.phone_norm
--     holds whatever sb_phone_digits() gave at the time it was written, and
--     contact_timeline() falls back to comparing against it for rows that
--     have no lead or customer id. ... so the join gets cleverer and the
--     stored value stays exactly what it was.
--
-- The stored value did stay the same. The join never got cleverer. It is
-- still a raw equality:
--
--     or (ident.phone is not null and cl.phone_norm = ident.phone)
--
-- and sb_phone_digits leaves the country code on, which sb_phone_key's own
-- comment spells out: "+1541... never equals 541...". Every row in
-- contact_log today was written from a phone somebody TYPED, so both sides
-- are 10 digits and it has always matched by luck of uniform input. An
-- orphan call is the first row whose number comes from a webhook in E.164,
-- and it would have been compared as 15415550101 against the lead's
-- 5415550101 — never equal, never shown, no error anywhere. The feature
-- would have looked built and done nothing.
--
-- So the join gets cleverer, as intended. Keys on both sides.
--
-- IT CANNOT UN-MATCH ANYTHING. Equal digits key to equal keys, so every row
-- that matched before still matches; this only adds the pairs that differ
-- by a country code. The rest of the function is reproduced unchanged from
-- db/contact-history.sql — `create or replace` has no way to patch one line
-- — and verify/orphan-calls.sql diffs the two copies and fails if any other
-- line has drifted. Same guard as the address ladder in verify/job-address.mjs,
-- for the same reason: a stale copy of a function is a bug fix that silently
-- un-applies itself the next time somebody runs the migrations in order.

create or replace function public.contact_timeline(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (
  at             timestamptz,
  source         text,
  kind           text,
  from_status    text,
  to_status      text,
  amount         numeric,
  payment_method text,
  detail         text,
  actor          text,
  job_date       timestamptz,
  visit_number   int,
  service_plan   text,
  is_extra       boolean,
  seq            bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ident record;
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  return query
  -- outreach
  select cl.created_at, 'contact'::text, cl.kind,
         cl.from_status, cl.to_status, null::numeric, null::text,
         cl.detail, p.full_name,
         null::timestamptz, null::int, null::text, null::boolean, cl.id
  from public.contact_log cl
  left join public.profiles p on p.id = cl.changed_by
  where cl.lead_id = any(ident.lead_ids)
     or cl.customer_id = any(ident.customer_ids)
     or (ident.phone is not null
         and public.sb_phone_key(cl.phone_norm) = public.sb_phone_key(ident.phone))

  union all

  -- lead milestones. 'call' rows are excluded: contact_log owns outreach
  -- now, and the backfill below copies the old ones across, so including
  -- both would show every historic call twice.
  select le.created_at, 'lead'::text, le.kind,
         le.from_status, le.to_status, null::numeric, null::text,
         null::text, p.full_name,
         null::timestamptz, null::int, null::text, null::boolean, le.id
  from public.lead_events le
  left join public.profiles p on p.id = le.changed_by
  where le.lead_id = any(ident.lead_ids)
    and coalesce(le.kind, 'status') <> 'call'

  union all

  -- job milestones
  select je.created_at, 'job'::text, je.kind,
         je.from_status, je.to_status, je.amount, je.payment_method,
         je.detail, p.full_name,
         j.starts_at, j.visit_number, j.service_plan, j.is_extra, je.id
  from public.job_events je
  join public.jobs j on j.id = je.job_id
  left join public.profiles p on p.id = je.changed_by
  where j.lead_id = any(ident.lead_ids)
     or j.customer_id = any(ident.customer_ids)

  -- Timestamp, then the source row's own id. A trigger writes several
  -- rows inside one statement, so they share now() to the microsecond and
  -- ordering by time alone put "payment" above "completed".
  order by 1, 14;
end;
$$;

-- The plain (phone_norm, created_at) index cannot serve a comparison wrapped
-- in a function call, and the predicate above is now wrapped on both sides.
-- sb_phone_key is immutable, so it can be indexed directly.
create index if not exists contact_log_phone_key_idx
  on public.contact_log (public.sb_phone_key(phone_norm));


-- ---------------------------------------------------------------------------
-- 3. Which rows are orphans
-- ---------------------------------------------------------------------------
--
-- A view rather than a repeated predicate, because section 3 deletes on this
-- definition and section 4 reports on it, and those two disagreeing is the
-- one failure here that destroys data instead of merely annoying somebody.

create or replace view public.orphan_calls as
  select
    cl.id,
    cl.phone_norm,
    cl.kind,
    cl.detail,
    cl.created_at
  from public.contact_log cl
  where cl.lead_id is null
    and cl.customer_id is null
    -- CALLS ONLY. Texts reach contact_log by a different route with its own
    -- rules about orphans (db/sms-app-messages.sql), and a sweep that
    -- quietly widened to cover them would be deleting rows this file never
    -- wrote and never reasoned about.
    and cl.kind in ('call', 'call_attempt', 'call_in', 'call_missed')
    -- STILL UNCLAIMED. The row's ids are null because nobody owned the
    -- number WHEN THE CALL HAPPENED; if somebody owns it now, the call is on
    -- their timeline today and is not an orphan whatever its columns say.
    and cl.phone_norm is not null
    -- KEYS, NOT DIGITS, and this is the line that decides whether the sweep
    -- deletes somebody's visible history. Section 2 made the timeline match
    -- on keys; if this predicate stayed on raw digits, a lead whose phone
    -- was typed "541-555-0101" would NOT be found here for a call stored as
    -- 15415550101 — so the row would be called an orphan and deleted at 90
    -- days, while appearing on her page the whole time. The two comparisons
    -- have to be the same comparison.
    and not exists (
      select 1 from public.leads l
      where public.sb_phone_key(l.phone) = public.sb_phone_key(cl.phone_norm)
    )
    and not exists (
      select 1 from public.customers c
      where public.sb_phone_key(c.phone) = public.sb_phone_key(cl.phone_norm)
    );

comment on view public.orphan_calls is
  'Calls logged against a phone number that still belongs to nobody in the
   CRM. A number that has since become a lead or customer is NOT here — that
   call is on their timeline.';


-- ---------------------------------------------------------------------------
-- 4. The sweep
-- ---------------------------------------------------------------------------

create or replace function public.sb_sweep_orphan_calls(p_days int default 90)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  gone int;
begin
  -- THE FLOOR. A caller passing 0 — or a cron with an unset variable
  -- expanding to nothing — would otherwise delete every unmatched call ever
  -- recorded, including the one from this morning for the lead somebody is
  -- about to type in. One day is the shortest window that still means
  -- "yesterday's".
  if p_days is null or p_days < 1 then
    p_days := 90;
  end if;

  delete from public.contact_log cl
  using public.orphan_calls o
  where cl.id = o.id
    and o.created_at < now() - make_interval(days => p_days);

  get diagnostics gone = row_count;
  return gone;
end;
$$;

comment on function public.sb_sweep_orphan_calls(int) is
  'Delete calls to numbers that still belong to nobody, older than p_days
   (default 90). Rows whose number has since become a lead or customer are
   never touched. Returns how many went.';

revoke all on function public.sb_sweep_orphan_calls(int) from public;
grant execute on function public.sb_sweep_orphan_calls(int) to service_role;


-- ---------------------------------------------------------------------------
-- 5. What is in there right now
-- ---------------------------------------------------------------------------

do $$
declare
  total   int;
  claimed int;
  stale   int;
begin
  select count(*) into total
  from public.contact_log
  where lead_id is null and customer_id is null
    and kind in ('call', 'call_attempt', 'call_in', 'call_missed');

  select count(*) into stale from public.orphan_calls
  where created_at < now() - interval '90 days';

  -- The interesting number: rows written with no ids whose number has since
  -- become somebody. Zero before the first call lands; above zero, it is
  -- this feature working.
  claimed := total - (select count(*) from public.orphan_calls);

  raise notice 'orphan calls: % total, % since claimed by a lead or customer, % older than 90 days and sweepable',
    total, claimed, stale;
end;
$$;
