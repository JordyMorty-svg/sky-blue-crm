\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE WRITES AND DELETES ROWS. Throwaway Postgres only, never      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it writes rows. It only '
      'runs against a scratch database built by verify/sms-fixture.sql and '
      'verify/call-fixture.sql.';
  end if;
end $$;

-- Assertions for db/call-history-cleanup.sql.
--
-- THE DANGEROUS DIRECTION HERE IS DELETION. Everything else in this project
-- fails by writing something wrong, which somebody can see and argue with.
-- This file removes history, and a row it takes by mistake is gone.
--
-- So the checks are weighted: more of them are about what must SURVIVE than
-- about what must go.
--
-- Checks marked THE POINT are the ones this file exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

-- A board with one lead and a mixed history: two button presses, one call
-- Quo confirmed, one call somebody logged by hand after the cutoff, one
-- inbound call, and an email.
create or replace function pg_temp.seed()
returns void language plpgsql as $$
begin
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;

  insert into public.leads (id, name, phone, status, contact_attempts, last_contacted_at)
  values ('d0000000-0000-0000-0000-000000000001', 'Dana Reyes', '(541) 555-0101',
          'contacted', 5, '2026-10-06T22:00:00Z');

  insert into public.contact_log
    (lead_id, phone_norm, kind, detail, provider_call_id, direction, created_at, changed_by)
  values
    -- Two button presses. No Quo id, before the cutoff.
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'call', null,
     null, 'out', '2026-10-06T15:08:00Z', null),
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'call', null,
     null, 'out', '2026-10-06T15:09:00Z', null),
    -- A call Quo confirmed. Before the cutoff, but it has an id.
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'call', '0m 17s',
     'AC-real', 'out', '2026-10-06T16:00:00Z', null),
    -- An inbound button-press-shaped row. No id, before the cutoff, but it
    -- never counted toward contact_attempts and must not be decremented.
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'call_missed', null,
     null, 'in', '2026-10-06T17:00:00Z', null),
    -- Logged by hand AFTER the cutoff, through the form that still exists.
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'call',
     'Rang him from my own phone', null, 'out', '2026-10-07T09:00:00Z', null),
    -- Not a call at all.
    ('d0000000-0000-0000-0000-000000000001', '5415550101', 'email', 'Quote sent',
     null, 'out', '2026-10-06T12:00:00Z', null);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The dry run is the default, and it deletes nothing
-- ---------------------------------------------------------------------------

do $$
declare r record; n int;
begin
  perform pg_temp.seed();

  select * into r from public.purge_click_logged_calls('2026-10-07T00:00:00Z');

  perform pg_temp.chk('the dry run finds the button presses',
    r.rows_removed = 3,
    'rows_removed = ' || r.rows_removed || ' — two outgoing and one inbound');

  select count(*) into n from public.contact_log;
  perform pg_temp.chk(
    'THE POINT: and the dry run has deleted nothing at all',
    n = 6,
    n || ' rows left of 6 — a default that deletes is a default nobody can '
    'safely type at eleven at night');

  select contact_attempts into n from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('...nor touched the counter', n = 5, 'contact_attempts = ' || n);
end $$;

-- ---------------------------------------------------------------------------
-- 2. What survives
-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  perform pg_temp.seed();
  perform public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);

  select count(*) into n from public.contact_log where provider_call_id = 'AC-real';
  perform pg_temp.chk(
    'THE POINT: a call Quo confirmed survives, however old it is',
    n = 1,
    'the cutoff is about who wrote the row, and a Quo id answers that '
    'regardless of when');

  select count(*) into n from public.contact_log
   where detail = 'Rang him from my own phone';
  perform pg_temp.chk(
    'THE POINT: a call somebody logged by hand after the cutoff survives',
    n = 1,
    'the Log a contact form writes the same shape as the old button on '
    'purpose, and deleting those would be taking real history');

  select count(*) into n from public.contact_log where kind = 'email';
  perform pg_temp.chk('an email is not a call and is left alone', n = 1);

  select count(*) into n from public.contact_log;
  perform pg_temp.chk('three of six rows went', n = 3, n || ' left');
end $$;

-- ---------------------------------------------------------------------------
-- 3. The counter
-- ---------------------------------------------------------------------------

do $$
declare n int; t timestamptz;
begin
  perform pg_temp.seed();
  perform public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);

  select contact_attempts into n from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk(
    'THE POINT: the counter gives back exactly what the deleted rows added',
    n = 3,
    'contact_attempts = ' || n || ' — five, less the two OUTGOING presses. '
    'The inbound one never incremented it and must not decrement it');

  select last_contacted_at into t from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('last reached out is recomputed from what is left',
    t = '2026-10-07T09:00:00Z',
    coalesce(t::text, 'null'));
end $$;

-- A lead whose ONLY outreach was button presses goes back to never contacted.
do $$
declare n int; t timestamptz;
begin
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;

  insert into public.leads (id, name, phone, status, contact_attempts, last_contacted_at)
  values ('d0000000-0000-0000-0000-000000000002', 'Only Presses', '(541) 555-0199',
          'contacted', 2, '2026-10-06T15:09:00Z');

  insert into public.contact_log
    (lead_id, phone_norm, kind, provider_call_id, direction, created_at)
  values
    ('d0000000-0000-0000-0000-000000000002', '5415550199', 'call', null, 'out',
     '2026-10-06T15:08:00Z'),
    ('d0000000-0000-0000-0000-000000000002', '5415550199', 'call', null, 'out',
     '2026-10-06T15:09:00Z');

  perform public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);

  select contact_attempts, last_contacted_at into n, t from public.leads
   where id = 'd0000000-0000-0000-0000-000000000002';

  perform pg_temp.chk('a lead with nothing but presses is back to zero', n = 0,
    'contact_attempts = ' || n);
  perform pg_temp.chk(
    'THE POINT: and to never reached out, which is the truth',
    t is null,
    'last_contacted_at = ' || coalesce(t::text, 'null') || ' — "last called '
    '6 Oct" when the only call was a button press is the lie this is here '
    'to undo');
end $$;

-- A call they made TO US is not us reaching out, however recent it is.
--
-- This one survived a first pass of the mutation run: in every other case
-- the latest surviving row happened to be outgoing, so dropping the
-- direction test from the recompute changed nothing and no assertion
-- noticed. A boundary that is never actually crossed is not tested.
do $$
declare t timestamptz;
begin
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;

  insert into public.leads (id, name, phone, status, contact_attempts, last_contacted_at)
  values ('d0000000-0000-0000-0000-000000000003', 'Rang Us Back', '(541) 555-0177',
          'contacted', 2, '2026-10-06T15:09:00Z');

  insert into public.contact_log
    (lead_id, phone_norm, kind, provider_call_id, direction, created_at)
  values
    -- A button press, which goes.
    ('d0000000-0000-0000-0000-000000000003', '5415550177', 'call', null, 'out',
     '2026-10-06T15:09:00Z'),
    -- Outreach that survives, in the middle.
    ('d0000000-0000-0000-0000-000000000003', '5415550177', 'email', null, 'out',
     '2026-10-06T18:00:00Z'),
    -- THEY rang US, later than anything we did, and it has a Quo id so it
    -- survives. It must not become "last reached out".
    ('d0000000-0000-0000-0000-000000000003', '5415550177', 'call_in', 'AC-theirs', 'in',
     '2026-10-08T11:00:00Z');

  perform public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);

  select last_contacted_at into t from public.leads
   where id = 'd0000000-0000-0000-0000-000000000003';

  perform pg_temp.chk(
    'THE POINT: a call they made to us is not us reaching out',
    t = '2026-10-06T18:00:00Z',
    'last_contacted_at = ' || coalesce(t::text, 'null') || ' — the inbound '
    'call is more recent and still is not outreach; "last reached out 8 Oct" '
    'would stop the follow-up automation chasing somebody nobody has chased');
end $$;

-- The counter must never go negative, whatever the history says.
do $$
declare n int;
begin
  perform pg_temp.seed();
  update public.leads set contact_attempts = 1
   where id = 'd0000000-0000-0000-0000-000000000001';

  perform public.purge_click_logged_calls('2026-10-07T00:00:00Z', true);

  select contact_attempts into n from public.leads
   where id = 'd0000000-0000-0000-0000-000000000001';
  perform pg_temp.chk('a counter that was already too low stops at zero',
    n = 0, 'contact_attempts = ' || n);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The cutoff is honoured
-- ---------------------------------------------------------------------------

do $$
declare r record; n int;
begin
  perform pg_temp.seed();

  -- A cutoff before everything takes nothing.
  select * into r from public.purge_click_logged_calls('2026-01-01T00:00:00Z', true);
  perform pg_temp.chk('a cutoff before the history takes nothing',
    r.rows_removed = 0, 'rows_removed = ' || r.rows_removed);

  select count(*) into n from public.contact_log;
  perform pg_temp.chk('...and leaves every row', n = 6, n || ' left');

  -- A cutoff after everything takes the hand-logged one too, which is why
  -- the cutoff is passed in and not guessed.
  perform pg_temp.seed();
  select * into r from public.purge_click_logged_calls('2026-12-01T00:00:00Z');
  perform pg_temp.chk('a later cutoff reaches further, as asked',
    r.rows_removed = 4, 'rows_removed = ' || r.rows_removed);
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — the presses go, the calls stay, and nothing goes without being asked';
end $$;
