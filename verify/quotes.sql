-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it. Without it the guard raises, psql
-- shrugs, and the DELETEs below run anyway — which is the entire failure
-- this is meant to prevent. In the Supabase SQL editor the RAISE aborts the
-- surrounding transaction on its own, so nothing after it commits there.
\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE DELETES ROWS. It is for a THROWAWAY Postgres, never for      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- #                                                                        #
-- #  The guard below is not documentation. Pasting this file into the       #
-- #  Supabase SQL editor raises before it touches anything, because only a  #
-- #  database built by a verify/*-fixture.sql has the marker table it       #
-- #  looks for.                                                             #
-- #                                                                        #
-- #  It exists because "run db/sms-delivery.sql, not                        #
-- #  verify/sms-delivery.sql" is a one-character distinction, and a         #
-- #  one-character distinction should never be the only thing standing      #
-- #  between a paste and an empty leads table.                              #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it deletes rows. It only '
      'runs against a scratch database built by the matching '
      'verify/*-fixture.sql, which creates public._scratch_db. If you meant '
      'to apply a migration, the file you want is in db/.';
  end if;
end $$;

-- verify/quotes.sql
--
-- The accept path, which is the part with money and strangers in it.
--
-- What matters most here, in order:
--   1. A customer accepting pays the BOOKING FEE TO WHOEVER SENT THE QUOTE.
--      They have no session, so without the actor override the fee is
--      created for a null profile and silently dropped.
--   2. Accepting twice books once. Customers double-tap.
--   3. An expired quote cannot be accepted, and a bad token reveals nothing.

\set ON_ERROR_STOP on
\pset pager off

create temporary table t (name text, pass boolean, detail text);
create or replace function chk(n text, p boolean, d text default '') returns void
language sql as $$ insert into t values (n, p, d); $$;

-- --- fixtures -------------------------------------------------------------

insert into profiles (id, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', 'Jordan',  'admin'),
  ('22222222-2222-2222-2222-222222222222', 'Trenton', 'partner');

insert into leads (id, name, address, status, estimate) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Marilyn Coats', '1014 NE Diane Pl', 'quoted', 180),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Blythe Utz',    '55 SW 3rd',        'quoted', 0),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Dee Prescott',  '9 NW Elm',         'quoted', 0),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Already Booked','2 SW Oak',         'booked', 400);

-- Trenton quotes Marilyn $250.
insert into quotes (token, lead_id, customer_name, address, amount, sent_by, status, sent_at)
values ('tok_marilyn', 'aaaaaaaa-0000-0000-0000-000000000001', 'Marilyn Coats',
        '1014 NE Diane Pl', 250, '22222222-2222-2222-2222-222222222222', 'sent', now());

-- An expired one.
insert into quotes (token, lead_id, customer_name, amount, sent_by, status, sent_at, expires_at)
values ('tok_expired', 'aaaaaaaa-0000-0000-0000-000000000002', 'Blythe Utz', 300,
        '11111111-1111-1111-1111-111111111111', 'sent', now() - interval '40 days',
        now() - interval '10 days');

-- One with no sender recorded — an older row, or a quote made in the table
-- editor. Must still book the job; it just pays nobody.
insert into quotes (token, lead_id, customer_name, amount, status, sent_at)
values ('tok_nosender', 'aaaaaaaa-0000-0000-0000-000000000003', 'Dee Prescott', 120,
        'sent', now());

-- --- 1. the public read ---------------------------------------------------

select chk('a valid token returns exactly one quote',
  (select count(*) from sb_quote_public('tok_marilyn')) = 1);

select chk('it shows the amount that was quoted',
  (select amount from sb_quote_public('tok_marilyn')) = 250);

select chk('a bad token returns nothing at all, not an error',
  (select count(*) from sb_quote_public('tok_nonsense')) = 0);

-- The leak test. If this list ever grows a customer id or a phone number,
-- a guessed token stops being harmless.
-- Reads the function's declared OUT parameters. If someone later adds
-- customer_id or phone to the return, this fails rather than quietly
-- widening what a guessed token is worth.
select chk('the public view returns only the nine safe columns',
  (select array_length(proargnames, 1) from pg_proc
    where proname = 'sb_quote_public') = 10,
  (select array_to_string(proargnames, ',') from pg_proc
    where proname = 'sb_quote_public'));

select chk('...no customer id, lead id, or sender leaks',
  not exists (
    select 1 from information_schema.routines r
     where r.routine_name = 'sb_quote_public'
       and (r.routine_definition ilike '%q.customer_id%'
         or r.routine_definition ilike '%q.lead_id%'
         or r.routine_definition ilike '%q.sent_by%')));

-- Opening it marks it viewed, which is what makes "sent but never opened"
-- worth a different follow-up from "opened and ignored".
select chk('opening a sent quote marks it viewed',
  (select status from quotes where token = 'tok_marilyn') = 'viewed');

select chk('...and stamps the time once',
  (select viewed_at is not null from quotes where token = 'tok_marilyn'));

-- --- 2. accepting, and who gets paid --------------------------------------

-- No session. This is exactly the customer's situation.
-- Session-level (false), not transaction-local: psql autocommits each
-- statement, so a transaction-local setting would be gone by the next line.
select set_config('test.uid', '', false);

select chk('accept succeeds',
  (select ok from sb_accept_quote('tok_marilyn')));

select chk('the lead moves to booked',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'booked');

select chk('the quote is marked accepted with a timestamp',
  (select status = 'accepted' and accepted_at is not null
     from quotes where token = 'tok_marilyn'));

-- The headline. Trenton sent it; Trenton is owed the booking fee, even though
-- the person who clicked was a stranger with no login.
select chk('THE POINT: the booking fee is attributed to whoever sent it',
  (select profile_id from commissions
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'book')
    = '22222222-2222-2222-2222-222222222222',
  coalesce((select profile_id::text from commissions
             where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'NOBODY PAID'));

-- The accepted price is what the customer agreed to, so it is what the
-- commission must be calculated against — not the older estimate of 180.
select chk('the accepted amount replaces the stale estimate',
  (select estimate from leads where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 250);

select chk('...and the fee is based on the accepted amount',
  (select base_amount from commissions
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'book') = 250);

-- The override must not persist. If it leaked, the next status change in the
-- same session would be misattributed to Trenton.
select chk('the actor override does not leak past its transaction',
  coalesce(current_setting('sb.actor', true), '') = '');

-- --- 3. idempotency -------------------------------------------------------

select chk('a second accept still reports success',
  (select ok from sb_accept_quote('tok_marilyn')));

select chk('...and says it was already accepted',
  (select already from sb_accept_quote('tok_marilyn')));

select chk('...and does NOT book a second fee',
  (select count(*) from commissions
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'book') = 1,
  (select count(*)::text from commissions
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'book'));

select chk('...and does not add another lead event',
  (select count(*) from lead_events
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000001' and to_status = 'booked') = 1);

-- --- 4. refusals ----------------------------------------------------------

select chk('an expired quote is refused',
  not (select ok from sb_accept_quote('tok_expired')));

select chk('...with a reason the page can explain',
  (select reason from sb_accept_quote('tok_expired')) = 'expired');

select chk('...and the lead stays where it was',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000002') = 'quoted');

select chk('an unknown token is refused',
  not (select ok from sb_accept_quote('tok_nonsense')));

select chk('...and is not distinguishable as "deleted"',
  (select reason from sb_accept_quote('tok_nonsense')) = 'not_found');

-- --- 5. edge cases --------------------------------------------------------

select chk('a quote with no recorded sender still books the job',
  (select ok from sb_accept_quote('tok_nosender')));

select chk('...the lead moves',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000003') = 'booked');

select chk('...it simply pays nobody, rather than failing',
  (select count(*) from commissions
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000003') = 0);

-- Accepting must never drag a job backwards out of scheduled or completed.
insert into quotes (token, lead_id, customer_name, amount, sent_by, status, sent_at)
values ('tok_late', 'aaaaaaaa-0000-0000-0000-000000000004', 'Already Booked', 500,
        '11111111-1111-1111-1111-111111111111', 'sent', now());

select chk('accepting against an already-booked lead does not rewind it',
  (select status from leads where id = 'aaaaaaaa-0000-0000-0000-000000000004') = 'booked')
  from (select sb_accept_quote('tok_late')) _;

-- --- 6. ordinary CRM changes are unaffected -------------------------------
--
-- The actor override is an addition, not a replacement. A normal signed-in
-- status change must still attribute to the session user.

select set_config('test.uid', '11111111-1111-1111-1111-111111111111', false);
insert into leads (id, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000005', 'Normal Path', 'quoted');
update leads set status = 'booked', estimate = 99
  where id = 'aaaaaaaa-0000-0000-0000-000000000005';

select chk('a signed-in user still gets credited normally',
  (select changed_by from lead_events
    where lead_id = 'aaaaaaaa-0000-0000-0000-000000000005' and to_status = 'booked')
    = '11111111-1111-1111-1111-111111111111');

-- --- report ---------------------------------------------------------------

select case when pass then 'PASS' else 'FAIL' end || '  ' || name
       || case when pass then '' else '  — ' || detail end as result
  from t order by ctid;

select count(*) filter (where pass) || '/' || count(*) || ' passed' as score from t;

do $$
declare n int;
begin
  select count(*) into n from t where not pass;
  if n > 0 then raise exception '% assertion(s) failed', n; end if;
end $$;
