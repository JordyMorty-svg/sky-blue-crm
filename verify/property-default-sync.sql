-- verify/property-default-sync.sql — the default address IS the customer's
--
-- NEVER RUN THIS AGAINST SUPABASE. It deletes rows. The guard below refuses
-- to run anywhere that is not the scratch database.
--
--   psql -d sb -f verify/property-default-sync.sql
--
-- Checks marked THE POINT are the ones this file exists for.

\set ON_ERROR_STOP on
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

create temporary table results (ok boolean, what text);

create or replace function pg_temp.chk(p_what text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  insert into results values (p_ok, p_what);
  if p_ok then
    raise notice 'ok    %', p_what;
  else
    raise notice 'FAIL  %', p_what ||
      case when p_detail <> '' then e'\n        ' || p_detail else '' end;
  end if;
end $$;

delete from public.quotes;
delete from public.jobs;
delete from public.customer_properties;
delete from public.customers;

insert into public.customers (id, name, phone, address, latitude, longitude)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Dana Reyes', '5415550101',
        '100 Model Home Way, Corvallis, OR', 44.5646, -123.2620);

insert into public.customer_properties (id, customer_id, label, address, latitude, longitude, is_primary)
values
  ('eeeeeeee-0000-0000-0000-00000000000a', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Model home', '100 Model Home Way, Corvallis, OR', 44.5646, -123.2620, true),
  ('eeeeeeee-0000-0000-0000-00000000000b', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
   'Main house', '742 Evergreen Terrace, Philomath, OR', 44.5700, -123.2800, false);

\echo ''
\echo '-- switching the default --'
\echo ''

select public.sb_set_primary_property('eeeeeeee-0000-0000-0000-00000000000b');

select pg_temp.chk(
  'THE POINT: the customer''s address follows the new default',
  (select address from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    = '742 Evergreen Terrace, Philomath, OR',
  'the profile used to keep showing the old house while every new job was '
  'booked at the new one, and both were right according to whichever part '
  'of the app you asked');

select pg_temp.chk(
  'THE POINT: and so do the coordinates',
  (select latitude from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') = 44.5700,
  'an address from one building and a pin from another is the one case '
  'where the map confidently sends the van to the wrong house');

\echo ''
\echo '-- correcting the default in place --'
\echo ''

update public.customer_properties
   set address = '742 Evergreen Terrace, Corvallis, OR'
 where id = 'eeeeeeee-0000-0000-0000-00000000000b';

select pg_temp.chk(
  'fixing a typo on the default fixes the customer record too',
  (select address from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    = '742 Evergreen Terrace, Corvallis, OR');

\echo ''
\echo '-- what must NOT move the customer''s address --'
\echo ''

update public.customer_properties
   set address = 'EDITED, not the default'
 where id = 'eeeeeeee-0000-0000-0000-00000000000a';

select pg_temp.chk(
  'THE POINT: editing a non-default property leaves the customer alone',
  (select address from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    = '742 Evergreen Terrace, Corvallis, OR',
  'otherwise renaming the old model home would silently move the customer '
  'back to it');

-- ARCHIVING THE DEFAULT. sb_set_primary_property is the supported route and
-- propertyService refuses to archive a default while another exists, but
-- the trigger must not blank anything if it happens anyway: they still live
-- somewhere, and "we retired that address" is not "we lost it".
update public.customer_properties
   set archived_at = now(), is_primary = false
 where id = 'eeeeeeee-0000-0000-0000-00000000000b';

select pg_temp.chk(
  'THE POINT: archiving the default does not blank the customer''s address',
  (select address from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    = '742 Evergreen Terrace, Corvallis, OR',
  'a customer with no address on file cannot be quoted, invoiced or driven to');

-- ARCHIVING A NON-DEFAULT ONE, whose address differs from the customer's.
--
-- The case above archives the default, whose address already MATCHED the
-- customer record — so a trigger that wrongly fired on archive would write
-- the same value back and nothing would look wrong. This one differs, so a
-- trigger firing on the wrong rows moves the customer to a building they
-- just retired.
update public.customer_properties
   set archived_at = now()
 where id = 'eeeeeeee-0000-0000-0000-00000000000a';

select pg_temp.chk(
  'THE POINT: archiving a non-default property does not move the customer',
  (select address from public.customers where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd')
    = '742 Evergreen Terrace, Corvallis, OR',
  'retiring the old model home must not relocate them to it');

\echo ''
\echo '-- adding the first property to a customer who had none --'
\echo ''

insert into public.customers (id, name, phone)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'No Address Nan', '5415550202');

insert into public.customer_properties (customer_id, address, latitude, longitude, is_primary)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '9 New Street, Albany, OR', 44.6365, -123.1059, true);

select pg_temp.chk(
  'a first property fills in an address the customer never had',
  (select address from public.customers where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff')
    = '9 New Street, Albany, OR',
  'this is the path a lead-only customer takes when somebody finally adds '
  'their address from the booking screen');

\echo ''

do $$
declare bad int;
begin
  select count(*) into bad from results where not ok;
  if bad = 0 then
    raise notice 'all ok — the profile and the van agree on which house';
  else
    raise exception '% FAILED', bad;
  end if;
end $$;
