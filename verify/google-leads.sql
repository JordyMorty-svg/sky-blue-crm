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

-- Assertions for db/google-leads.sql.
--
-- THE DANGEROUS DIRECTION HERE IS DUPLICATION, and it has two faces.
--
-- A poll re-reads its own window on purpose, so the same lead arrives again
-- and again. If that writes a second row, Sky Blue pays for one lead and the
-- board shows two people who do not exist.
--
-- The subtler one: an LSA phone lead has usually ALREADY rung the Quo number,
-- so a call is sitting on somebody's timeline before Google's record of it
-- arrives. A new lead created beside that person splits one conversation
-- across two pages, and both look half-answered. Most of this file is about
-- attaching rather than creating.
--
-- Checks marked THE POINT are the ones this file exists for.

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

create or replace function pg_temp.reset()
returns void language plpgsql as $$
begin
  delete from public.google_leads;
  delete from public.contact_log;
  delete from public.lead_events;
  delete from public.leads;
  delete from public.customers;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A lead for somebody nobody knows
-- ---------------------------------------------------------------------------

do $$
declare new_id uuid; l record; c record; g record;
begin
  perform pg_temp.reset();

  new_id := public.record_google_lead(
    'LSA-1', 'Marion Webb', '(541) 555-0144', null,
    '2026-10-06T15:30:00Z', 'PHONE_CALL', 'window_cleaning', 'svc-1',
    'ENABLED', true, 'Asked about exterior windows on a two-storey');

  perform pg_temp.chk('a new lead is created', new_id is not null);

  select * into l from public.leads where id = new_id;
  perform pg_temp.chk('...with the name Google gave', l.name = 'Marion Webb', l.name);
  perform pg_temp.chk('...and the number', l.phone = '(541) 555-0144', l.phone);
  perform pg_temp.chk('...on New, waiting for somebody', l.status = 'new', l.status);

  perform pg_temp.chk(
    'THE POINT: the source says Google CHARGED for this one',
    l.source = 'lsa',
    'source = ' || l.source || ' — and it must be the key LEAD_SOURCES already '
    'uses, not a new one: sourceFor() shows an unknown key as its raw string, '
    'so a second spelling splits one channel across two labels on the board'); 

  select * into g from public.google_leads where google_lead_id = 'LSA-1';
  perform pg_temp.chk('what Google charged is kept', g.charged is true);
  perform pg_temp.chk('...with their own id, type and category',
    g.lead_type = 'PHONE_CALL' and g.category_id = 'window_cleaning');
  perform pg_temp.chk('...attached to the lead', g.lead_id = new_id);
  perform pg_temp.chk(
    'THE POINT: and dated when GOOGLE says it happened',
    g.lead_at = '2026-10-06T15:30:00Z',
    'lead_at = ' || coalesce(g.lead_at::text, 'null') || ' — an hourly poll '
    'must not stamp an 08:05 lead as 09:00');

  select * into c from public.contact_log where lead_id = new_id;
  perform pg_temp.chk('THE POINT: the timeline says where it came from',
    c.kind = 'google_lead',
    'kind = ' || coalesce(c.kind, 'null') || ' — without it a lead Google '
    'charged for reads exactly like one somebody met at a door');
  perform pg_temp.chk('...in Google''s words',
    c.detail = 'Asked about exterior windows on a two-storey', c.detail);
  perform pg_temp.chk('...dated to the lead, not to the poll',
    c.created_at = '2026-10-06T15:30:00Z', coalesce(c.created_at::text, 'null'));
end $$;

-- THE SOURCE KEY MUST BE ONE THE APP KNOWS.
--
-- Not a style point. sourceFor() in src/services/leadService.js deliberately
-- does NOT fall back to a default for an unrecognised key — it shows the raw
-- string, so a key this migration invents appears on the board as
-- "google_lsa" beside leads labelled "Google Ads (LSA)", and every report
-- splits one paid channel into two. The first draft of this file did exactly
-- that.
do $$
declare known boolean;
begin
  -- The list as leadService.js holds it. Written out because this file cannot
  -- import JavaScript, and checked rather than assumed because the whole
  -- failure is a value that looks fine in the database.
  select 'lsa' = any(array['door','outreach','website','referral','social',
                           'google','lsa','signage','other'])
    into known;

  perform pg_temp.chk(
    'THE POINT: the source written here is a key LEAD_SOURCES already defines',
    known,
    'an unknown key renders as its raw string on the board, so one channel '
    'ends up with two labels and neither total is right');
end $$;

-- ---------------------------------------------------------------------------
-- 2. The same lead again, which is what a poll does
-- ---------------------------------------------------------------------------

do $$
declare first uuid; again uuid; n int;
begin
  perform pg_temp.reset();

  first := public.record_google_lead('LSA-2', 'Dana Reyes', '(541) 555-0101',
    null, '2026-10-06T10:00:00Z', 'MESSAGE', null, null, 'ENABLED', true, null);
  again := public.record_google_lead('LSA-2', 'Dana Reyes', '(541) 555-0101',
    null, '2026-10-06T10:00:00Z', 'MESSAGE', null, null, 'ENABLED', true, null);

  perform pg_temp.chk('the first one is recorded', first is not null);
  perform pg_temp.chk(
    'THE POINT: the second one is not, and says so',
    again is null,
    'the poll overlaps its own window on purpose, so most of what it reads it '
    'has read before — the caller counts a null as "nothing new"');

  select count(*) into n from public.leads;
  perform pg_temp.chk('...leaving exactly one lead', n = 1, n || ' leads');

  select count(*) into n from public.contact_log;
  perform pg_temp.chk(
    'THE POINT: ...and exactly one timeline entry',
    n = 1,
    n || ' rows — the lead deduplicated and the timeline did not, which is '
    'how a board stays right while the history underneath it doubles');
end $$;

-- A LEAD THAT WAS DELETED, and the poll comes round again.
--
-- This is why the repeat guard is a guard and not redundant with the ON
-- CONFLICT below it. A mutation run removed it and every other check still
-- passed: the conflict still caught the duplicate google_leads row and the
-- function still returned null. What it did NOT catch was the leads row
-- created on the way there, before the conflict was reached — an orphan
-- appearing on the board days after somebody deleted it, with no way to make
-- it stay deleted.
--
-- Not hypothetical. Deleting a test lead and watching it come back is exactly
-- how this would be found in use.
do $$
declare first_id uuid; again uuid; n int;
begin
  perform pg_temp.reset();

  first_id := public.record_google_lead('LSA-GONE', 'Temp Person', '5415550166',
    null, '2026-10-06T09:00:00Z', 'PHONE_CALL', null, null, null, true, null);
  perform pg_temp.chk('the lead is created the first time', first_id is not null);

  -- Somebody deletes it.
  delete from public.contact_log where lead_id = first_id;
  delete from public.leads where id = first_id;

  again := public.record_google_lead('LSA-GONE', 'Temp Person', '5415550166',
    null, '2026-10-06T09:00:00Z', 'PHONE_CALL', null, null, null, true, null);

  perform pg_temp.chk('the next poll reports nothing new', again is null);

  select count(*) into n from public.leads;
  perform pg_temp.chk(
    'THE POINT: a deleted lead stays deleted when the poll comes round again',
    n = 0,
    n || ' leads — without the repeat guard the row is created before the '
    'conflict is reached, so a deleted lead reappears and cannot be made to '
    'stay gone');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Somebody we already know
-- ---------------------------------------------------------------------------
--
-- The case that matters most, because it is the common one: the LSA call rang
-- the Quo number first, so there is already a record.

do $$
declare new_id uuid; n int; l record;
begin
  perform pg_temp.reset();

  insert into public.leads (id, name, phone, status, source)
  values ('d0000000-0000-0000-0000-000000000001', 'Dana Reyes',
          '(541) 555-0101', 'contacted', 'website');

  new_id := public.record_google_lead('LSA-3', 'Dana R', '+15415550101', null,
    now(), 'PHONE_CALL', null, null, 'ENABLED', true, 'Rang about gutters');

  perform pg_temp.chk(
    'THE POINT: an existing lead is attached to, not duplicated',
    new_id = 'd0000000-0000-0000-0000-000000000001',
    'got ' || coalesce(new_id::text, 'null') || ' — a second record beside them '
    'splits one conversation across two pages and both look half-answered');

  select count(*) into n from public.leads;
  perform pg_temp.chk('...so there is still one lead', n = 1, n || ' leads');

  select * into l from public.leads where id = new_id;
  perform pg_temp.chk(
    'THE POINT: and their existing name is not overwritten by Google''s',
    l.name = 'Dana Reyes',
    'name = ' || l.name || ' — a name somebody typed beats a name an ad '
    'platform guessed');

  perform pg_temp.chk('...nor is their status reset to New',
    l.status = 'contacted', l.status);
  perform pg_temp.chk(
    'THE POINT: but the source IS corrected to the channel that charged for it',
    l.source = 'lsa',
    'source = ' || l.source || ' — the one field here that overwrites a human '
    'choice, on purpose: Google charged for this lead and knows where it came '
    'from, and leaving it alone credits the free channel for work the paid one '
    'delivered');

  select count(*) into n from public.contact_log where kind = 'google_lead';
  perform pg_temp.chk('but the timeline still records the paid lead', n = 1);
end $$;

-- A number typed one way and sent another is still the same person. Same
-- sb_phone_key() matching the whole CRM uses.
do $$
declare new_id uuid; n int;
begin
  perform pg_temp.reset();
  insert into public.leads (id, name, phone, status, source)
  values ('d0000000-0000-0000-0000-000000000002', 'Pat Lowe', '5415550177',
          'new', 'door');

  new_id := public.record_google_lead('LSA-4', 'Pat', '+1 (541) 555-0177', null,
    now(), 'PHONE_CALL', null, null, null, false, null);

  perform pg_temp.chk('THE POINT: a number formatted differently is the same person',
    new_id = 'd0000000-0000-0000-0000-000000000002',
    'got ' || coalesce(new_id::text, 'null'));

  select count(*) into n from public.leads;
  perform pg_temp.chk('...and still one lead', n = 1, n || ' leads');
end $$;

-- An existing CUSTOMER. They are not a lead any more and must not become one
-- again because they rang an ad.
do $$
declare new_id uuid; n int; g record;
begin
  perform pg_temp.reset();
  insert into public.customers (id, name, phone)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'Judy Okafor', '(541) 555-0190');

  new_id := public.record_google_lead('LSA-5', 'Judy', '5415550190', null, now(),
    'PHONE_CALL', null, null, null, true, null);

  select count(*) into n from public.leads;
  perform pg_temp.chk(
    'THE POINT: an existing customer does not become a new lead',
    n = 0,
    n || ' leads created — somebody who already buys from you is not a lead, '
    'and putting them back on the board is how they get sold to twice');

  select * into g from public.google_leads where google_lead_id = 'LSA-5';
  perform pg_temp.chk('...the lead is attached to the customer',
    g.customer_id = 'aaaaaaaa-0000-0000-0000-000000000001');

  select count(*) into n from public.contact_log
   where customer_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'google_lead';
  perform pg_temp.chk('...and it is on their timeline', n = 1);
end $$;

-- ---------------------------------------------------------------------------
-- 4. What Google did not tell us
-- ---------------------------------------------------------------------------

do $$
declare new_id uuid; l record; n int;
begin
  perform pg_temp.reset();

  -- A phone lead often carries only a number.
  new_id := public.record_google_lead('LSA-6', null, '(541) 555-0155', null,
    now(), 'PHONE_CALL', null, null, null, true, null);

  select * into l from public.leads where id = new_id;
  perform pg_temp.chk(
    'THE POINT: a lead with no name still gets a readable one',
    l.name = 'Google lead · 0155',
    'name = ' || coalesce(l.name, 'null') || ' — null renders as a blank row '
    'on the board, which reads as a bug rather than as missing information');

  -- AND IT HAS TO BE DISTINGUISHABLE. Five of the first seven real leads on
  -- this account carried no name, so a single shared placeholder would be a
  -- board of identical rows nobody can tell apart, search for, or hand to
  -- somebody else to call.
  perform public.record_google_lead('LSA-6b', null, '(541) 555-0156', null,
    now(), 'PHONE_CALL', null, null, null, true, null);

  perform pg_temp.chk(
    'THE POINT: two nameless leads do not get the same name',
    (select count(distinct name) from public.leads
      where name like 'Google lead%') = 2,
    (select string_agg(name, ', ') from public.leads where name like 'Google lead%'));

  -- ...and a later lead from the same number that DOES have a name fills it in.
  perform public.record_google_lead('LSA-7', 'Sam Ortiz', '(541) 555-0155',
    'sam@example.com', now(), 'MESSAGE', null, null, null, true, null);

  select * into l from public.leads where id = new_id;
  perform pg_temp.chk(
    'THE POINT: and a real name later replaces the placeholder',
    l.name = 'Sam Ortiz',
    'name = ' || coalesce(l.name, 'null') || ' — a numbered placeholder is '
    'still a stand-in; matching only the bare string "Google lead" would have '
    'left every numbered one in place forever');
  perform pg_temp.chk('...and a missing email is filled in',
    l.email = 'sam@example.com', coalesce(l.email, 'null'));

  -- Scoped to the number under test. The block also creates a second
  -- nameless lead on a different number to prove the placeholders differ, and
  -- a bare count(*) would read that as a duplicate.
  select count(*) into n from public.leads where phone = '(541) 555-0155';
  perform pg_temp.chk('both leads for that number landed on one person',
    n = 1, n || ' leads');
end $$;

-- A lead Google has wiped: no contact details at all. Kept for the money,
-- attached to nobody.
do $$
declare new_id uuid; n int; g record;
begin
  perform pg_temp.reset();

  new_id := public.record_google_lead('LSA-8', null, null, null, now(),
    'PHONE_CALL', null, null, 'WIPED_OUT', true, null);

  select count(*) into n from public.leads;
  perform pg_temp.chk(
    'THE POINT: a wiped lead does not invent a person with no number',
    n = 0,
    n || ' leads — contact_details is null when lead_status is WIPED_OUT, and '
    'a lead row with no name and no number is an empty card nobody can action');

  select * into g from public.google_leads where google_lead_id = 'LSA-8';
  perform pg_temp.chk(
    'THE POINT: but the charge is still recorded',
    g.charged is true and g.lead_id is null,
    'Google billed for it either way, and a cost with no record is a cost '
    'nobody reconciles');

  select count(*) into n from public.contact_log;
  perform pg_temp.chk('...with no timeline entry, because there is no timeline',
    n = 0, n || ' rows');
end $$;

-- No id at all is refused outright.
do $$
declare n int;
begin
  perform pg_temp.reset();
  perform pg_temp.chk('a lead with no Google id is refused',
    public.record_google_lead(null, 'Nobody', '5415550101') is null);
  perform pg_temp.chk('...and an empty one too',
    public.record_google_lead('   ', 'Nobody', '5415550101') is null);

  select count(*) into n from public.leads;
  perform pg_temp.chk('THE POINT: ...leaving nothing behind',
    n = 0,
    n || ' leads — no id means no dedupe, and no dedupe means every poll '
    're-creates every lead');
end $$;

-- ---------------------------------------------------------------------------
-- 5. The high-water mark
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.reset();

  perform pg_temp.chk(
    'THE POINT: an empty table has no high-water mark, and says null',
    public.latest_google_lead_at() is null,
    'the first run reads it as "go back far enough to catch up"; a zero or a '
    'now() here would skip every lead that already exists');

  perform public.record_google_lead('LSA-9', 'A', '5415550101', null,
    '2026-10-01T09:00:00Z', null, null, null, null, null, null);
  perform public.record_google_lead('LSA-10', 'B', '5415550102', null,
    '2026-10-05T09:00:00Z', null, null, null, null, null, null);
  perform public.record_google_lead('LSA-11', 'C', '5415550103', null,
    '2026-10-03T09:00:00Z', null, null, null, null, null, null);

  perform pg_temp.chk('the newest lead is the high-water mark',
    public.latest_google_lead_at() = '2026-10-05T09:00:00Z',
    coalesce(public.latest_google_lead_at()::text, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 6. A page at a time
-- ---------------------------------------------------------------------------

do $$
declare n int; c int;
begin
  perform pg_temp.reset();

  n := public.record_google_leads($j$[
    {"id":"P-1","name":"One","phone":"5415550201","at":"2026-10-06T09:00:00Z","type":"PHONE_CALL","charged":true},
    {"id":"P-2","name":"Two","phone":"5415550202","at":"2026-10-06T09:05:00Z","type":"MESSAGE","charged":false},
    {"id":"P-3","name":"Three","phone":"5415550203","at":"2026-10-06T09:10:00Z","type":"BOOKING","charged":true}
  ]$j$::jsonb);

  perform pg_temp.chk('a page imports and counts what was new', n = 3, n || ' new');

  select count(*) into c from public.leads;
  perform pg_temp.chk('...one lead each', c = 3, c || ' leads');

  -- Run it again with one new entry, which is what the next poll looks like.
  n := public.record_google_leads($j$[
    {"id":"P-2","name":"Two","phone":"5415550202","at":"2026-10-06T09:05:00Z","type":"MESSAGE","charged":false},
    {"id":"P-3","name":"Three","phone":"5415550203","at":"2026-10-06T09:10:00Z","type":"BOOKING","charged":true},
    {"id":"P-4","name":"Four","phone":"5415550204","at":"2026-10-06T10:00:00Z","type":"MESSAGE","charged":true}
  ]$j$::jsonb);

  perform pg_temp.chk(
    'THE POINT: the next poll counts only what it had not seen',
    n = 1,
    n || ' reported new — an overlapping window is how nothing falls through '
    'the gap, so "already had it" must not be counted as an import');

  select count(*) into c from public.leads;
  perform pg_temp.chk('...and nothing doubled', c = 4, c || ' leads');

  -- A LEAD WITH NO `charged` KEY AT ALL. Written out because the first
  -- version of this check counted nulls across a page where every row stated
  -- one — it could not fail, and a mutant that defaulted the missing case to
  -- false survived it.
  --
  -- The distinction is money: "Google did not charge us" and "Google has not
  -- said yet" are different, and only one of them should be added up.
  perform public.record_google_leads($k$[
    {"id":"P-9","name":"Unstated","phone":"5415550209","at":"2026-10-06T11:00:00Z"}
  ]$k$::jsonb);

  select count(*) into c from public.google_leads
   where google_lead_id = 'P-9' and charged is null;
  perform pg_temp.chk(
    'THE POINT: a charge Google has not stated stays unknown, not false',
    c = 1,
    'false reads as "this lead was free", which is a number somebody adds up');
end $$;

-- One bad row loses only itself.
do $$
declare n int; c int;
begin
  perform pg_temp.reset();

  n := public.record_google_leads($j$[
    {"id":"B-1","name":"Good","phone":"5415550211","at":"2026-10-06T09:00:00Z"},
    {"id":"B-2","name":"Bad date","phone":"5415550212","at":"not a date"},
    {"id":"B-3","name":"Also good","phone":"5415550213","at":"2026-10-06T09:10:00Z"}
  ]$j$::jsonb);

  perform pg_temp.chk(
    'THE POINT: a lead with an unparseable date loses only itself',
    n = 2,
    n || ' of 3 — a page that dies on its worst row imports nothing, and from '
    'the outside that is indistinguishable from "no new leads"');

  select count(*) into c from public.leads;
  perform pg_temp.chk('...and the good ones are there', c = 2, c || ' leads');
end $$;

do $$
begin
  perform pg_temp.chk('an empty page is not an error',
    public.record_google_leads('[]'::jsonb) = 0);
  perform pg_temp.chk('...nor a null one',
    public.record_google_leads(null) = 0);
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — a paid lead lands on the person it belongs to, once';
end $$;
