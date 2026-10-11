-- verify/quote-property.sql — which building is this quote for?
--
-- NEVER RUN THIS AGAINST SUPABASE. It deletes rows. The guard below refuses
-- to run anywhere that is not the scratch database.
--
--   psql -d sb -f verify/quote-property.sql
--
-- The backfill in db/quote-property.sql is the whole subject here, and what
-- it is tested for is RESTRAINT. It would be easy to write one that
-- attributes every quote to a building and is wrong about some of them, and
-- a wrong attribution is worse than a null: null reads as "nobody recorded
-- this", a wrong id reads as a fact.

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

-- ---------------------------------------------------------------------------
-- Two customers: one with a single building, one with two
-- ---------------------------------------------------------------------------

insert into public.customers (id, name, phone, address)
values
  ('b1111111-1111-1111-1111-111111111111', 'Single Site Sam', '5415550001',
   '12 Elm St, Corvallis, OR'),
  ('b2222222-2222-2222-2222-222222222222', 'Two House Dana', '5415550002',
   '100 Model Home Way, Corvallis, OR');

insert into public.customer_properties (id, customer_id, address, is_primary)
values
  ('a1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111',
   '12 Elm St, Corvallis, OR', true),
  ('a2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222',
   '100 Model Home Way, Corvallis, OR', true),
  ('a3333333-3333-3333-3333-333333333333', 'b2222222-2222-2222-2222-222222222222',
   '742 Evergreen Terrace, Corvallis, OR', false);

insert into public.quotes (id, customer_id, customer_name, address, amount, status)
values
  -- One property, address matches exactly. The only safe case.
  ('11111111-0000-0000-0000-000000000001', 'b1111111-1111-1111-1111-111111111111',
   'Single Site Sam', '12 Elm St, Corvallis, OR', 300, 'sent'),
  -- One property, matches apart from case and padding.
  ('11111111-0000-0000-0000-000000000002', 'b1111111-1111-1111-1111-111111111111',
   'Single Site Sam', '  12 ELM ST, CORVALLIS, OR  ', 310, 'sent'),
  -- One property, and the address is a near miss. A human would say these
  -- are the same place. The backfill must not.
  ('11111111-0000-0000-0000-000000000003', 'b1111111-1111-1111-1111-111111111111',
   'Single Site Sam', '12 Elm Street', 320, 'sent'),
  -- TWO properties, and the quote's address matches one of them exactly.
  -- Still refused: this is the customer the whole feature exists for, and
  -- matching on a string that happens to agree today is how a $395 model
  -- home quote gets attached to the house they live in.
  ('22222222-0000-0000-0000-000000000001', 'b2222222-2222-2222-2222-222222222222',
   'Two House Dana', '742 Evergreen Terrace, Corvallis, OR', 900, 'sent'),
  -- A lead-only quote. No customer, nothing to attribute it to.
  ('33333333-0000-0000-0000-000000000001', null,
   'Someone New', '9 Nowhere Ln', 150, 'draft');

\i db/quote-property.sql

\echo ''
\echo '-- what the backfill linked --'
\echo ''

select pg_temp.chk(
  'a quote for a customer with one matching property is linked',
  (select property_id from public.quotes where id = '11111111-0000-0000-0000-000000000001')
    = 'a1111111-1111-1111-1111-111111111111');

select pg_temp.chk(
  'case and padding do not stop it',
  (select property_id from public.quotes where id = '11111111-0000-0000-0000-000000000002')
    = 'a1111111-1111-1111-1111-111111111111');

\echo ''
\echo '-- and what it refused to guess --'
\echo ''

select pg_temp.chk(
  'THE POINT: a near-miss address is left alone',
  (select property_id from public.quotes where id = '11111111-0000-0000-0000-000000000003') is null,
  '"12 Elm Street" and "12 Elm St, Corvallis, OR" are probably the same place, '
  'and probably is not good enough to stamp onto an offer');

select pg_temp.chk(
  'THE POINT: a customer with two buildings gets no guess at all',
  (select property_id from public.quotes where id = '22222222-0000-0000-0000-000000000001') is null,
  'even though the address matches one exactly — this is the customer the '
  'feature exists for, and a wrong attribution reads as a fact while a null '
  'reads as "nobody recorded it"');

select pg_temp.chk(
  'a lead-only quote is untouched',
  (select property_id from public.quotes where id = '33333333-0000-0000-0000-000000000001') is null);

\echo ''
\echo '-- the address the customer saw is never rewritten --'
\echo ''

-- THE LINE NOT TO CROSS. db/quotes.sql snapshots the address precisely so a
-- sent quote keeps saying what it said. A backfill that "tidied" the
-- near-miss address to match its property would be editing an offer
-- somebody is holding in their inbox.
select pg_temp.chk(
  'THE POINT: the backfill does not touch quotes.address',
  (select address from public.quotes where id = '11111111-0000-0000-0000-000000000003')
    = '12 Elm Street'
  and (select address from public.quotes where id = '11111111-0000-0000-0000-000000000002')
    = '  12 ELM ST, CORVALLIS, OR  ',
  'the quote in their inbox says what it said; rewriting it here would be '
  'editing an offer after it was made');

\echo ''
\echo '-- deleting a property leaves the quote readable --'
\echo ''

delete from public.customer_properties where id = 'a1111111-1111-1111-1111-111111111111';

select pg_temp.chk(
  'the quote survives, with the address still on it',
  (select address from public.quotes where id = '11111111-0000-0000-0000-000000000001')
    = '12 Elm St, Corvallis, OR'
  and (select property_id from public.quotes where id = '11111111-0000-0000-0000-000000000001') is null,
  'on delete set null — deleting an address must not delete the record of a '
  'price offered for it');

\echo ''

do $$
declare bad int;
begin
  select count(*) into bad from results where not ok;
  if bad = 0 then
    raise notice 'all ok — a quote names a building only when it knows which one';
  else
    raise exception '% FAILED', bad;
  end if;
end $$;
