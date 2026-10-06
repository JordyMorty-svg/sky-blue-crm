-- The state the database was actually in, before db/sms-app-messages.sql.
--
-- ############################################################################
-- #  NEVER RUN THIS AGAINST SUPABASE. It writes rows into a throwaway        #
-- #  stand-in schema. db/*.sql are the real migrations; verify/*.sql are not.#
-- ############################################################################
--
-- Seeds the damage, so the repair in section 6 of the migration has something
-- to repair. Written here rather than in the assertions file for the usual
-- reason: a suite that creates the broken rows AND checks them after its own
-- UPDATE stays green when somebody deletes the migration's repair block.
--
-- Run order:
--   verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,
--   db/email-delivery.sql, db/delivery-controls.sql
--   verify/sms-app-legacy.sql     <- this
--   db/sms-app-messages.sql
--   verify/sms-app-messages.sql

\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception 'REFUSING TO RUN. verify/ file; needs verify/sms-fixture.sql first.';
  end if;
end $$;

-- A customer whose number was typed in off a door hanger, with no country
-- code -- which is how essentially every number in the CRM is stored.
insert into public.customers (id, name, phone)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Orphaned Olive', '5415550190');

insert into public.leads (id, name, phone)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'Orphaned Owen', '5415550191');

-- Their replies, as the OLD record_inbound_sms() filed them: the message is
-- there, the link to the person is not. Quo sent '+1...', the stored number
-- had no '+1', sb_phone_digits() left the leading 1 on, nothing matched.
insert into public.sms_messages
  (direction, phone, body, kind, lead_id, customer_id, status, provider_sid, created_at)
values
  ('in', '+15415550190', 'Can you come Tuesday instead?', 'inbound', null, null, 'received', 'old_1', now() - interval '6 days'),
  ('in', '+15415550191', 'What would gutters cost?',      'inbound', null, null, 'received', 'old_2', now() - interval '4 days'),
  -- A reply from somebody genuinely not in the CRM. Must STAY unattached.
  ('in', '+15415550199', 'wrong number mate',             'inbound', null, null, 'received', 'old_3', now() - interval '2 days');

insert into public.contact_log (lead_id, customer_id, phone_norm, kind, detail, created_at)
values
  (null, null, '15415550190', 'text_in', 'Can you come Tuesday instead?', now() - interval '6 days'),
  (null, null, '15415550191', 'text_in', 'What would gutters cost?',      now() - interval '4 days');

-- A message attached to an OLD record, whose number a NEWER record now also
-- carries. sb_contact_for_phone() would answer "the newer one" — so a repair
-- written as a plain assignment rather than a coalesce would silently move
-- this message onto a customer who never received it.
insert into public.customers (id, name, phone, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Older Olga', '5415550193', now() - interval '2 years'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Newer Nate', '5415550193', now() - interval '1 day');
-- A lead also carries that number, so the row below IS missing something the
-- repair could fill in (its lead_id) and therefore IS in scope. Without this
-- lead the row is skipped entirely and proves nothing: the repair could be
-- rewritten to overwrite rather than fill in, and this case would never
-- notice. Mutation testing found exactly that.
insert into public.leads (id, name, phone)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'Same number, a lead', '5415550193');

insert into public.sms_messages
  (direction, phone, body, kind, customer_id, status, provider_sid, created_at)
values
  ('in', '+15415550193', 'from two years ago', 'inbound',
   'aaaaaaaa-0000-0000-0000-000000000003', 'received', 'old_5', now() - interval '2 years');

-- An already-attached row, to prove the repair only fills in what is missing
-- and never moves a message that already has a home.
insert into public.customers (id, name, phone)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'Already Fine', '5415550192');
insert into public.sms_messages
  (direction, phone, body, kind, customer_id, status, provider_sid, created_at)
values
  ('in', '+15415550192', 'already linked', 'inbound',
   'aaaaaaaa-0000-0000-0000-000000000002', 'received', 'old_4', now() - interval '1 day');
