-- verify/quote-preview.sql
--
-- Does p_mark actually decide whether a view is recorded?
--
-- The JavaScript suite (verify/quote-preview.mjs) proves the FUNCTION is
-- called with the right argument for each kind of caller. This proves the
-- argument does what it claims once it reaches the database. Neither is
-- sufficient alone: a correct decision passed to a function that ignores it
-- is still the original bug.
--
--   psql -f verify/quotes-fixture.sql -f db/quotes.sql \
--        -f db/quote-preview.sql -f verify/quote-preview.sql
--
-- *** NEVER run this against Supabase. *** quotes-fixture.sql opens with a
-- `drop table ... cascade`. Only db/*.sql are real migrations.

\set ON_ERROR_STOP on
\pset pager off

create or replace function chk(what text, pass boolean, detail text default '')
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  % %', what, coalesce(detail, '');
  end if;
end $$;

-- A quote in 'sent', which is the only status p_mark can move.
insert into profiles (id, full_name) values
  ('11111111-1111-1111-1111-111111111111', 'Jordan')
on conflict (id) do nothing;

insert into leads (id, name, status, estimate)
values ('22222222-2222-2222-2222-222222222222', 'Jane O''Brien', 'quoted', 450)
on conflict (id) do nothing;

-- Scoped to this suite's own id, not a bare `delete from quotes`.
--
-- quotes-fixture.sql drops the tables IT creates, but `quotes` is created by
-- db/quotes.sql with `if not exists`, so the row below survives a re-run and
-- the second run died on its own primary key. A suite that only passes on a
-- fresh database is a suite that stops being run.
delete from quotes where id = '33333333-3333-3333-3333-333333333333';

insert into quotes (id, lead_id, customer_name, amount, sent_by, status, sent_at, expires_at)
values (
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  'Jane O''Brien', 450,
  '11111111-1111-1111-1111-111111111111',
  'sent', now(), now() + interval '30 days'
);

do $$
declare
  qid   uuid := '33333333-3333-3333-3333-333333333333';
  tok   text;
  st    text;
  seen  timestamptz;
begin
  select token into tok from quotes where id = qid;

  -- ---------------------------------------------------------------------
  perform chk('starts out sent, never viewed',
    (select status from quotes where id = qid) = 'sent'
      and (select viewed_at from quotes where id = qid) is null);

  -- ---------------------------------------------------------------------
  -- Staff preview.
  -- ---------------------------------------------------------------------
  perform sb_quote_public(tok, false);

  select status, viewed_at into st, seen from quotes where id = qid;
  perform chk('THE POINT: p_mark false leaves the quote untouched',
    st = 'sent' and seen is null,
    format('status=%s viewed_at=%s', st, seen));

  -- Twice, because a rep checks a quote more than once.
  perform sb_quote_public(tok, false);
  perform sb_quote_public(tok, false);
  perform chk('and stays untouched however many times it is previewed',
    (select status from quotes where id = qid) = 'sent');

  perform chk('the preview still RETURNS the quote — it is not a no-op',
    (select customer_name from sb_quote_public(tok, false)) = 'Jane O''Brien');

  -- ---------------------------------------------------------------------
  -- The customer.
  -- ---------------------------------------------------------------------
  perform sb_quote_public(tok, true);

  select status, viewed_at into st, seen from quotes where id = qid;
  perform chk('a real open still records the view',
    st = 'viewed' and seen is not null,
    format('status=%s viewed_at=%s', st, seen));

  -- ---------------------------------------------------------------------
  -- Defaults and nulls: the dangerous direction must never be the one you
  -- get by accident.
  -- ---------------------------------------------------------------------
  update quotes set status = 'sent', viewed_at = null where id = qid;
  perform sb_quote_public(tok);
  perform chk('THE POINT: omitting p_mark marks it — the default is the safe-for-customers one',
    (select status from quotes where id = qid) = 'viewed',
    'a caller that forgets the argument must not silently stop recording opens');

  update quotes set status = 'sent', viewed_at = null where id = qid;
  perform sb_quote_public(tok, null);
  perform chk('an explicit NULL marks it too — "I do not know who this is" records the open',
    (select status from quotes where id = qid) = 'viewed');

  -- ---------------------------------------------------------------------
  -- Things a preview must never do.
  -- ---------------------------------------------------------------------
  update quotes set status = 'accepted', accepted_at = now() where id = qid;
  perform sb_quote_public(tok, true);
  perform chk('an accepted quote is never walked backwards by a view',
    (select status from quotes where id = qid) = 'accepted');

  update quotes set status = 'declined' where id = qid;
  perform sb_quote_public(tok, false);
  perform chk('nor is a declined one',
    (select status from quotes where id = qid) = 'declined');

  -- ---------------------------------------------------------------------
  perform chk('a bad token returns nothing, previewed or not',
    not exists (select 1 from sb_quote_public('nope', false))
      and not exists (select 1 from sb_quote_public('nope', true)));

  -- ---------------------------------------------------------------------
  -- The old signature must be GONE, not merely shadowed. Two overloads
  -- differing only by a defaulted argument make sb_quote_public('x')
  -- ambiguous, and PostgREST picks one by rules nobody reading this expects.
  perform chk('exactly one sb_quote_public exists',
    (select count(*) from pg_proc where proname = 'sb_quote_public') = 1,
    format('found %s', (select count(*) from pg_proc where proname = 'sb_quote_public')));

  raise notice '';
  raise notice 'all ok - p_mark holds';
end $$;
