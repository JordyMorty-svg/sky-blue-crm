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
      'runs against a scratch database built by verify/quotes-fixture.sql.';
  end if;
end $$;

-- Assertions for db/quote-accept-job.sql.
--
-- Run order is in verify/quote-accept-job-fixture.sql.
--
-- The case these exist for: Vicki Guenther accepted $1,195 of work at her
-- SECOND address and no job appeared anywhere. Two things had to be true for
-- that — acceptance created nothing for a customer-backed quote, and the
-- only screen that showed the acceptance claimed a job existed.

create or replace function assert(cond boolean, label text) returns void
language plpgsql as $$
begin
  if cond then
    raise notice 'ok    %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- Cast
-- --------------------------------------------------------------------------

delete from public.quotes;
delete from public.jobs;
delete from public.lead_events;
delete from public.commissions;
delete from public.leads;
delete from public.customers;
delete from public.profiles;

insert into public.profiles (id, full_name, role)
values ('11111111-1111-1111-1111-111111111111', 'Jordan', 'admin');

insert into public.customers (id, name)
values ('22222222-2222-2222-2222-222222222222', 'Vicki Guenther');

insert into public.leads (id, name, status, estimate)
values ('33333333-3333-3333-3333-333333333333', 'A New Lead', 'quoted', 400);

-- --------------------------------------------------------------------------
-- 1. THE POINT: a customer quote creates a job you can find
-- --------------------------------------------------------------------------

insert into public.quotes
  (id, token, customer_id, customer_name, address, service_keys, amount,
   status, sent_by, property_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tok-customer',
   '22222222-2222-2222-2222-222222222222', 'Vicki Guenther',
   '900 Second Address Rd, Corvallis, OR',
   array['residential-window-washing', 'gutter-cleaning'],
   1195.00, 'sent', '11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444');

select assert((select ok from public.sb_accept_quote('tok-customer')),
  'accepting a customer quote reports success');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: a job now exists, which before this file it did not');

select assert(
  (select status from public.jobs) = 'upcoming',
  'THE POINT: ...as upcoming, because nobody has agreed a date');

select assert((select starts_at from public.jobs) is null,
  '...with no start time, which is what upcoming means');

select assert((select price from public.jobs) = 1195.00,
  'the job carries the accepted amount, not a stale estimate');

-- The reason quotes.property_id was added in the first place. Vicki's
-- second address is not her primary one, and a job that guessed would send
-- the van to the wrong house.
select assert(
  (select property_id from public.jobs) = '44444444-4444-4444-4444-444444444444',
  'THE POINT: the job is at the property that was QUOTED, not the default');

select assert(
  (select address from public.jobs) = '900 Second Address Rd, Corvallis, OR',
  '...and carries the address the customer was actually shown');

select assert(
  (select service_keys from public.jobs)
    @> array['residential-window-washing', 'gutter-cleaning'],
  'both quoted services come across');

select assert(
  (select customer_id from public.jobs) = '22222222-2222-2222-2222-222222222222',
  'the job belongs to the customer');

-- Both directions, so the Jobs board can label the card without a second
-- query and delete_quote() can refuse honestly.
select assert(
  (select from_quote_id from public.jobs) = 'aaaaaaaa-0000-0000-0000-000000000001',
  'the job points back at the quote');

select assert(
  (select closed_job_id from public.quotes where token = 'tok-customer')
    = (select id from public.jobs),
  'THE POINT: and the quote points at the job — both links, one transaction');

-- --------------------------------------------------------------------------
-- 2. Accepting twice does not book the work twice
-- --------------------------------------------------------------------------

select assert((select already from public.sb_accept_quote('tok-customer')),
  'a second acceptance reports already-accepted');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: ...and creates no second job');

-- --------------------------------------------------------------------------
-- 3. A lead quote still behaves exactly as it did
-- --------------------------------------------------------------------------
--
-- The lead path already worked: the lead goes to booked, lands on the board,
-- somebody presses Schedule and scheduleJob() makes the job. Creating an
-- upcoming job here as well would double-book every new customer.

insert into public.quotes
  (token, lead_id, customer_name, amount, status, sent_by)
values
  ('tok-lead', '33333333-3333-3333-3333-333333333333', 'A New Lead',
   650.00, 'sent', '11111111-1111-1111-1111-111111111111');

select assert((select ok from public.sb_accept_quote('tok-lead')),
  'accepting a lead quote reports success');

select assert(
  (select status from public.leads
    where id = '33333333-3333-3333-3333-333333333333') = 'booked',
  'the lead moves to booked');

select assert(
  (select estimate from public.leads
    where id = '33333333-3333-3333-3333-333333333333') = 650.00,
  'the lead estimate becomes the accepted amount');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: a lead quote still creates NO job — the board does that');

select assert(
  (select count(*) from public.commissions
    where profile_id = '11111111-1111-1111-1111-111111111111') = 1,
  'the booking commission still fires for the sender');

-- A QUOTE CAN CARRY BOTH, and the first version of this suite could not see
-- it. quotes.sql says so in its own comment — "A quote hangs off a lead, a
-- customer, or both" — which is what happens once a lead has been converted.
-- The lead quote above had no customer_id, so a mutant that ran the customer
-- branch for every quote passed every assertion here: the branch simply never
-- fired. Found by mutation, not by reading.
insert into public.leads (id, name, status, estimate)
values ('55555555-5555-5555-5555-555555555555', 'Converted Lead', 'quoted', 300);

insert into public.quotes
  (token, lead_id, customer_id, customer_name, amount, status, sent_by)
values
  ('tok-both', '55555555-5555-5555-5555-555555555555',
   '22222222-2222-2222-2222-222222222222', 'Both', 800.00, 'sent',
   '11111111-1111-1111-1111-111111111111');

select assert((select ok from public.sb_accept_quote('tok-both')),
  'a quote carrying both a lead and a customer is accepted');

select assert(
  (select status from public.leads
    where id = '55555555-5555-5555-5555-555555555555') = 'booked',
  '...the lead moves to booked');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: ...and it creates no job, because the lead path owns it');

-- --------------------------------------------------------------------------
-- 4. Refusals are unchanged, and still come before any job is made
-- --------------------------------------------------------------------------

insert into public.quotes (token, customer_id, customer_name, amount, status)
values ('tok-expired', '22222222-2222-2222-2222-222222222222', 'Vicki',
        100, 'sent');
update public.quotes set expires_at = now() - interval '1 day'
 where token = 'tok-expired';

select assert(
  (select reason from public.sb_accept_quote('tok-expired')) = 'expired',
  'an expired quote is refused');

insert into public.quotes (token, customer_id, customer_name, amount, status)
values ('tok-closed', '22222222-2222-2222-2222-222222222222', 'Vicki',
        100, 'closed');

select assert(
  (select reason from public.sb_accept_quote('tok-closed')) = 'closed',
  'a closed quote is refused — the link is an endpoint, not a button');

select assert(
  (select reason from public.sb_accept_quote('tok-nope')) = 'not_found',
  'an unknown token is refused');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: no refusal created a job on its way out');

-- The `closed_job_id is null` guard on the insert looked like belt and
-- braces — a second acceptance returns early, so how would a quote with a
-- job reach the insert? A mutant that deleted the guard survived, which
-- means nothing was testing it. Rather than call it equivalent and move on,
-- here is the state it actually defends against: a row that already names a
-- job but is not marked accepted. Nothing in the app creates that today;
-- a half-finished migration or a hand-edited row would.
insert into public.quotes
  (token, customer_id, customer_name, amount, status, closed_job_id)
values
  ('tok-prebooked', '22222222-2222-2222-2222-222222222222', 'Vicki',
   400, 'sent', (select id from public.jobs limit 1));

select assert((select ok from public.sb_accept_quote('tok-prebooked')),
  'a quote that already names a job can still be accepted');

select assert((select count(*) from public.jobs) = 1,
  'THE POINT: ...but the work is never booked twice against one quote');

-- --------------------------------------------------------------------------
-- 5. The message that sent Jordan looking for a job that did not exist
-- --------------------------------------------------------------------------

-- Accepted WITH a job: naming the job is now true, so it is still said.
do $$
declare msg text;
begin
  begin
    perform public.delete_quote('aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'FAIL  an accepted quote with a job should not delete';
  exception when others then
    msg := sqlerrm;
  end;
  perform assert(msg like '%a job was created from it%',
    'THE POINT: with a job, the refusal says so');
end $$;

-- Accepted with NO job — the Vicki case before this file. The old message
-- asserted a job and a booking fee; both were false.
insert into public.quotes (id, token, customer_id, customer_name, amount, status)
values ('aaaaaaaa-0000-0000-0000-000000000009', 'tok-bare',
        '22222222-2222-2222-2222-222222222222', 'Vicki', 500, 'accepted');

do $$
declare msg text;
begin
  begin
    perform public.delete_quote('aaaaaaaa-0000-0000-0000-000000000009');
    raise exception 'FAIL  an accepted quote should not delete';
  exception when others then
    msg := sqlerrm;
  end;
  perform assert(msg not like '%job%',
    'THE POINT: with no job, the refusal does not claim one exists');
  perform assert(msg like '%agreed to pay%',
    '...and gives the real reason instead');
end $$;

-- A quote with nothing attached is still deletable, or this whole function
-- would just be a wall.
insert into public.quotes (id, token, customer_id, customer_name, amount, status)
values ('aaaaaaaa-0000-0000-0000-00000000000a', 'tok-draft',
        '22222222-2222-2222-2222-222222222222', 'Vicki', 200, 'draft');

select assert(
  public.delete_quote('aaaaaaaa-0000-0000-0000-00000000000a'),
  'a draft quote still deletes');

select assert(
  not public.delete_quote('aaaaaaaa-0000-0000-0000-00000000000a'),
  'deleting it twice is false, not an error');

-- --------------------------------------------------------------------------

do $$ begin raise notice '--- all assertions passed ---'; end $$;
