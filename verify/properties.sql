-- verify/properties.sql — one customer, several addresses
--
-- NEVER RUN THIS AGAINST SUPABASE. It drops and recreates tables. The guard
-- below refuses to run anywhere that is not the scratch database.
--
--   psql -d sb -f verify/properties.sql
--
-- Checks marked THE POINT are the ones this file exists for. Everything else
-- is scaffolding to make those reachable.

\set ON_ERROR_STOP on
-- chk() returns void; without this every call prints an empty result table.
\pset tuples_only on
\pset format unaligned

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This file deletes data. It only runs where '
      'public._scratch_db exists, which Supabase does not have.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A table the real schema does not have, so a failure is loud
-- ---------------------------------------------------------------------------

create temporary table results (ok boolean, what text, detail text);

create or replace function pg_temp.chk(p_what text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into results values (p_ok, p_what, p_detail);
  if p_ok then
    raise notice 'ok    %', p_what;
  else
    raise notice 'FAIL  %', p_what ||
      case when p_detail <> '' then e'\n        ' || p_detail else '' end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

delete from public.jobs;
delete from public.customer_properties;
delete from public.customers;
delete from public.leads;

insert into public.customers (id, name, phone, address, latitude, longitude)
values ('11111111-1111-1111-1111-111111111111', 'Dana Reyes', '5415550101',
        '100 Model Home Way, Corvallis, OR', 44.5646, -123.2620);

insert into public.leads (id, name, phone, address, latitude, longitude, status)
values ('22222222-2222-2222-2222-222222222222', 'Dana Reyes', '5415550101',
        '100 Model Home Way, Corvallis, OR', 44.5646, -123.2620, 'scheduled');

\echo ''
\echo '-- the backfill --'
\echo ''

-- RUN THE REAL MIGRATION, not a copy of its backfill.
--
-- The first version of this file pasted the two INSERT statements out of
-- db/properties.sql and asserted on those. It passed, and it was worthless:
-- a mutant that deleted the duplicate guard from the migration survived,
-- because the migration was never the thing being run. Same mistake
-- db/sms-backfill.sql taught this project once already.
--
-- The tables exist from the earlier apply; everything below is the file
-- itself, executed against these fixtures.
\i db/properties.sql

select pg_temp.chk(
  'a customer''s existing address becomes their primary property',
  (select count(*) from public.customer_properties
    where customer_id = '11111111-1111-1111-1111-111111111111'
      and is_primary and address = '100 Model Home Way, Corvallis, OR') = 1);

select pg_temp.chk(
  'THE POINT: ...and the coordinates come with it',
  (select latitude is not distinct from 44.5646 and longitude is not distinct from -123.2620
     from public.customer_properties
    where customer_id = '11111111-1111-1111-1111-111111111111'),
  'an address without its coordinates sends the van to a geocoder guess, and '
  'a rural address on the edge of Corvallis is exactly where that goes wrong');

-- Re-run it. A migration that makes a second copy of every address the
-- second time somebody runs it is worse than one that fails.
\i db/properties.sql

select pg_temp.chk(
  'THE POINT: running the backfill twice does not duplicate it',
  (select count(*) from public.customer_properties) = 1,
  (select count(*)::text || ' properties' from public.customer_properties));

\echo ''
\echo '-- one primary, enforced by the database --'
\echo ''

insert into public.customer_properties (id, customer_id, label, address, latitude, longitude)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        'Main house', '742 Evergreen Terrace, Corvallis, OR', 44.5700, -123.2800);

do $$
declare refused boolean := false;
begin
  begin
    update public.customer_properties set is_primary = true
     where id = '33333333-3333-3333-3333-333333333333';
  exception when unique_violation then refused := true;
  end;
  perform pg_temp.chk(
    'THE POINT: a second primary is refused by the database, not by a screen',
    refused,
    'two screens can set a primary; only the database can refuse the second');
end $$;

-- Archiving the primary frees the slot.
update public.customer_properties set archived_at = now(), is_primary = false
 where address like '100 Model Home%';

do $$
declare allowed boolean := true;
begin
  begin
    update public.customer_properties set is_primary = true
     where id = '33333333-3333-3333-3333-333333333333';
  exception when unique_violation then allowed := false;
  end;
  perform pg_temp.chk(
    'archiving the primary frees the slot for another',
    allowed);
end $$;

-- Put it back the way the rest of the file expects. CLEAR THE NEW PRIMARY
-- FIRST: the constraint this file just proved works will otherwise refuse
-- the restore, and the test file would fail on its own tidying-up.
update public.customer_properties set is_primary = false
 where id = '33333333-3333-3333-3333-333333333333';
update public.customer_properties set archived_at = null, is_primary = true
 where address like '100 Model Home%';

\echo ''
\echo '-- switching the primary --'
\echo ''

-- The obvious client-side version is "clear the old, set the new", which is
-- two round trips and can leave a customer with no primary at all if the
-- second never lands. sb_set_primary_property does it in one statement.
select public.sb_set_primary_property('33333333-3333-3333-3333-333333333333');

select pg_temp.chk(
  'THE POINT: switching the primary moves it rather than adding a second',
  (select count(*) from public.customer_properties
    where customer_id = '11111111-1111-1111-1111-111111111111'
      and is_primary and archived_at is null) = 1
  and (select is_primary from public.customer_properties
        where id = '33333333-3333-3333-3333-333333333333'),
  'one statement, so it cannot half-happen and leave nobody primary');

-- Back to how the rest of the file expects to find things.
select public.sb_set_primary_property(
  (select id from public.customer_properties where address like '100 Model Home%'));

\echo ''
\echo '-- where is this job? --'
\echo ''

-- Job A: the model home, booked against the primary property.
insert into public.jobs (id, lead_id, customer_id, property_id, status, starts_at, price)
values ('aaaaaaaa-0000-0000-0000-00000000000a',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        (select id from public.customer_properties where address like '100 Model Home%'),
        'scheduled', now() + interval '2 days', 395);

-- Job B: the house they actually live in. Same customer, same lead, same
-- phone, different building — the situation this whole file is about.
insert into public.jobs (id, lead_id, customer_id, property_id, status, starts_at, price)
values ('bbbbbbbb-0000-0000-0000-00000000000b',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'scheduled', now() + interval '9 days', 0);

select pg_temp.chk(
  'THE POINT: two jobs for one customer sit at two different addresses',
  (select address from public.sb_job_address('aaaaaaaa-0000-0000-0000-00000000000a'))
    = '100 Model Home Way, Corvallis, OR'
  and (select address from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b'))
    = '742 Evergreen Terrace, Corvallis, OR',
  'this is the whole feature: one customer, one invoice trail, two buildings');

select pg_temp.chk(
  'THE POINT: the coordinates belong to the same building as the address',
  (select latitude from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b')) = 44.5700,
  'taking the street name from the property and the pin from the customer '
  'sends the van to the wrong house with the right name on the screen, which '
  'is worse than having no pin at all');

-- A job with no property falls back to the customer.
insert into public.jobs (id, lead_id, customer_id, status, starts_at, price)
values ('cccccccc-0000-0000-0000-00000000000c',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        'scheduled', now() + interval '3 days', 100);

select pg_temp.chk(
  'a job with no property falls back to the customer',
  (select address from public.sb_job_address('cccccccc-0000-0000-0000-00000000000c'))
    = '100 Model Home Way, Corvallis, OR');

-- ...and the customer outranks the lead, which is the precedence the app
-- disagreed with itself about before this function existed.
update public.leads set address = 'OLD typo address' where id = '22222222-2222-2222-2222-222222222222';

select pg_temp.chk(
  'THE POINT: the customer record outranks the lead',
  (select address from public.sb_job_address('cccccccc-0000-0000-0000-00000000000c'))
    <> 'OLD typo address',
  'JobDetail read lead-first while JobRecord, ConfirmVisit and taxService '
  'read customer-first — two screens, two addresses, same job, neither wrong-looking');

-- A job with nothing but a lead still answers.
insert into public.jobs (id, lead_id, status, starts_at, price)
values ('dddddddd-0000-0000-0000-00000000000d',
        '22222222-2222-2222-2222-222222222222',
        'scheduled', now() + interval '4 days', 100);

select pg_temp.chk(
  'a lead-only job still has an address',
  (select address from public.sb_job_address('dddddddd-0000-0000-0000-00000000000d'))
    = 'OLD typo address');

\echo ''
\echo '-- a correction reaches work not yet done --'
\echo ''

update public.customer_properties
   set address = '742 Evergreen Terrace, Philomath, OR'
 where id = '33333333-3333-3333-3333-333333333333';

select pg_temp.chk(
  'THE POINT: fixing a typo on a property fixes the upcoming job',
  (select address from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b'))
    = '742 Evergreen Terrace, Philomath, OR',
  'this is why the job holds a pointer and not a copy while it is still a plan');

\echo ''
\echo '-- ...and never reaches work already done --'
\echo ''

update public.jobs set status = 'completed'
 where id = 'bbbbbbbb-0000-0000-0000-00000000000b';

select pg_temp.chk(
  'completing a job writes the address onto it',
  (select address from public.jobs where id = 'bbbbbbbb-0000-0000-0000-00000000000b')
    = '742 Evergreen Terrace, Philomath, OR');

select pg_temp.chk(
  '...with its coordinates',
  (select latitude from public.jobs where id = 'bbbbbbbb-0000-0000-0000-00000000000b') = 44.5700);

-- The customer moves. Everything ahead of us should follow; nothing behind
-- us may.
update public.customer_properties
   set address = '55 Somewhere Else Ave, Albany, OR', latitude = 44.6365, longitude = -123.1059
 where id = '33333333-3333-3333-3333-333333333333';

select pg_temp.chk(
  'THE POINT: a finished job keeps the address it was done at',
  (select address from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b'))
    = '742 Evergreen Terrace, Philomath, OR',
  'the customer moved house; the job we already did and invoiced did not move '
  'with them, and neither did the mileage we claimed for it');

select pg_temp.chk(
  '...including its coordinates',
  (select latitude from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b')) = 44.5700,
  'a frozen address with live coordinates is the worst of both');

-- Reopen and re-complete. A job that was completed, put back and completed
-- again must not quietly adopt today's address.
update public.jobs set status = 'scheduled' where id = 'bbbbbbbb-0000-0000-0000-00000000000b';
update public.jobs set status = 'completed' where id = 'bbbbbbbb-0000-0000-0000-00000000000b';

select pg_temp.chk(
  'THE POINT: reopening and re-completing does not re-freeze it',
  (select address from public.jobs where id = 'bbbbbbbb-0000-0000-0000-00000000000b')
    = '742 Evergreen Terrace, Philomath, OR',
  'the work happened where it happened; a second completion is a correction '
  'to the paperwork, not a change of venue');

\echo ''
\echo '-- deleting a property does not delete the history --'
\echo ''

delete from public.customer_properties where id = '33333333-3333-3333-3333-333333333333';

select pg_temp.chk(
  'THE POINT: the finished job survives its property being deleted',
  (select count(*) from public.jobs where id = 'bbbbbbbb-0000-0000-0000-00000000000b') = 1,
  'on delete set null, not cascade — deleting an address must never delete '
  'the record that we cleaned it and were paid');

select pg_temp.chk(
  '...and still knows where it was',
  (select address from public.sb_job_address('bbbbbbbb-0000-0000-0000-00000000000b'))
    = '742 Evergreen Terrace, Philomath, OR',
  'which is what the frozen copy is for');

\echo ''
\echo '-- the result --'
\echo ''

do $$
declare bad int;
begin
  select count(*) into bad from results where not ok;
  if bad = 0 then
    raise notice '';
    raise notice 'all ok — one customer, two houses, and history that stays put';
  else
    raise exception '% FAILED', bad;
  end if;
end $$;
