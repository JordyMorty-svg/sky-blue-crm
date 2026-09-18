-- Assertions for db/quote-history.sql.
--
-- Run against a THROWAWAY Postgres, after verify/quote-history-fixture.sql
-- and then db/quote-history.sql. Never against Supabase.
--
-- What this is checking: that a quote sent to somebody while they were a lead
-- is still there when you open them as a customer, and that it is not
-- duplicated, invented, or shown to the wrong person.

\set ON_ERROR_STOP on
\pset pager off

create or replace function chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then
    raise notice 'ok    %', what;
  else
    raise notice 'FAIL  %  %', what, coalesce(detail, '');
    update _score set failed = failed + 1;
  end if;
end $$;

create table if not exists _score (failed int not null default 0);
delete from _score;
insert into _score values (0);

-- ---------------------------------------------------------------------------
-- Marilyn: knocked as a lead, quoted, accepted, now a customer.
-- The exact journey the feature is about.
-- ---------------------------------------------------------------------------

insert into leads (id, name, phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Marilyn Hollingsworth', '(541) 555-0101', 'completed');

insert into customers (id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000001', 'Marilyn Hollingsworth', '(541) 555-0101');

-- The job is what actually ties the lead to the customer in this CRM.
insert into jobs (lead_id, customer_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'completed');

insert into quotes (id, lead_id, customer_name, amount, status, sent_at, accepted_at, sent_by)
values ('99999999-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'Marilyn Hollingsworth', 250, 'accepted',
        now() - interval '20 days', now() - interval '19 days',
        '11111111-1111-1111-1111-111111111111');

select chk('THE POINT: a quote sent to a lead shows on their customer profile',
  exists (select 1 from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
           where id = '99999999-0000-0000-0000-000000000001'),
  'the quote that won the job was invisible from the customer page');

select chk('it arrives with the status it actually has',
  (select status from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
    where id = '99999999-0000-0000-0000-000000000001') = 'accepted');

select chk('and keeps who sent it, for the commission trail',
  (select sender_name from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
    where id = '99999999-0000-0000-0000-000000000001') = 'Jordan Mortensen');

-- The flag the UI uses to explain itself. Without it the quote looks like a
-- duplicate of one somebody already sent from another screen.
select chk('it is marked as having come from the lead, not this record',
  (select from_elsewhere from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
    where id = '99999999-0000-0000-0000-000000000001'));

select chk('and viewed from the lead itself it is NOT marked as from elsewhere',
  (select from_elsewhere from quotes_for_contact('aaaaaaaa-0000-0000-0000-000000000001', null)
    where id = '99999999-0000-0000-0000-000000000001') = false);

select chk('the same quote appears once, not twice',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')) = 1,
  (select count(*)::text from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')));

-- ---------------------------------------------------------------------------
-- A second quote, sent later as a customer. Both should be there, newest
-- first, and only the older one flagged.
-- ---------------------------------------------------------------------------

insert into quotes (id, customer_id, customer_name, amount, status, sent_at, sent_by)
values ('99999999-0000-0000-0000-000000000002',
        'cccccccc-0000-0000-0000-000000000001',
        'Marilyn Hollingsworth', 300, 'sent', now() - interval '2 days',
        '22222222-2222-2222-2222-222222222222');

select chk('both quotes show on the customer',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')) = 2);

select chk('newest first',
  (select id from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001') limit 1)
    = '99999999-0000-0000-0000-000000000002');

select chk('only the one from the lead is flagged as from elsewhere',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
    where from_elsewhere) = 1);

-- Looking from the LEAD, the customer's later quote should be there too —
-- it is the same person, and "have we quoted them before" is the same
-- question whichever record you happen to have open.
select chk('the lead page shows the quote sent later as a customer',
  (select count(*) from quotes_for_contact('aaaaaaaa-0000-0000-0000-000000000001', null)) = 2);

-- ---------------------------------------------------------------------------
-- Several leads, one person. The case a backfill would have missed.
-- ---------------------------------------------------------------------------

-- Knocked again months later, same phone, never converted.
insert into leads (id, name, phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Marilyn H', '541-555-0101', 'lost');

insert into quotes (id, lead_id, customer_name, amount, status, sent_at)
values ('99999999-0000-0000-0000-000000000003',
        'aaaaaaaa-0000-0000-0000-000000000002',
        'Marilyn H', 275, 'declined', now() - interval '60 days');

select chk('THE POINT: a quote on a SECOND lead for the same person also shows',
  exists (select 1 from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
           where id = '99999999-0000-0000-0000-000000000003'),
  'this is the one a customer_id backfill would silently miss');

select chk('all three are now on the customer',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')) = 3,
  (select count(*)::text from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')));

-- ---------------------------------------------------------------------------
-- Somebody else entirely. The failure that matters most: one customer's
-- prices appearing on another customer's page.
-- ---------------------------------------------------------------------------

insert into customers (id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000002', 'Karen Emery', '(541) 555-0102');

insert into leads (id, name, phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Karen Emery', '(541) 555-0102', 'quoted');

insert into quotes (id, lead_id, customer_name, amount, status, sent_at)
values ('99999999-0000-0000-0000-000000000004',
        'aaaaaaaa-0000-0000-0000-000000000003', 'Karen Emery', 475, 'sent', now());

select chk('THE POINT: another person''s quote never leaks in',
  not exists (select 1 from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000001')
               where id = '99999999-0000-0000-0000-000000000004'),
  'Karen''s price showed up on Marilyn''s page');

select chk('and Karen sees only her own',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000002')) = 1);

-- ---------------------------------------------------------------------------
-- Nothing at all, and nothing that exists.
-- ---------------------------------------------------------------------------

insert into customers (id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000003', 'Blythe Okonkwo', '(541) 555-0103');

select chk('a customer with no quotes gets an empty list, not an error',
  (select count(*) from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000003')) = 0);

select chk('an id that does not exist is empty, not an error',
  (select count(*) from quotes_for_contact(null, '00000000-0000-0000-0000-000000000000')) = 0);

-- A customer with no phone on record can only be found by the job that ties
-- them to the lead. Worth its own case: the phone is the usual route home,
-- and this is the one where it isn't available.
insert into customers (id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000004', 'Trenton Vale', null);
insert into leads (id, name, phone, status) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Trenton Vale', null, 'completed');
insert into jobs (lead_id, customer_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004', 'completed');
insert into quotes (id, lead_id, customer_name, amount, status)
values ('99999999-0000-0000-0000-000000000005',
        'aaaaaaaa-0000-0000-0000-000000000004', 'Trenton Vale', 180, 'sent');

select chk('a customer with no phone still finds their lead''s quote, via the job',
  exists (select 1 from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000004')
           where id = '99999999-0000-0000-0000-000000000005'));

-- And that must not have made everyone-with-no-phone into one person.
select chk('customers with no phone are not merged together',
  not exists (select 1 from quotes_for_contact(null, 'cccccccc-0000-0000-0000-000000000003')));

-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  select failed into n from _score;
  if n = 0 then
    raise notice '';
    raise notice 'all assertions passed';
  else
    raise exception '% assertion(s) failed', n;
  end if;
end $$;
