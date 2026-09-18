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
  -- Counting opens (db/quote-views.sql).
  -- ---------------------------------------------------------------------
  update quotes set status = 'sent', viewed_at = null, last_viewed_at = null,
                    view_count = 0
   where id = qid;

  perform sb_quote_public(tok, false);
  perform sb_quote_public(tok, false);
  perform sb_quote_public(tok, false);
  perform chk('THE POINT: previewing does not inflate the open count',
    (select view_count from quotes where id = qid) = 0,
    format('view_count=%s — a count polluted by our own clicks is worse than no count',
           (select view_count from quotes where id = qid)));

  perform sb_quote_public(tok, true);
  perform chk('the customer''s first open counts',
    (select view_count from quotes where id = qid) = 1);

  perform sb_quote_public(tok, true);
  perform sb_quote_public(tok, true);
  perform chk('THE POINT: opening it again counts again',
    (select view_count from quotes where id = qid) = 3,
    'the old code only ever fired on the sent -> viewed transition, so a '
    'second open did nothing at all');

  -- Backdated deliberately. Every call above ran inside this one DO block,
  -- and now() is transaction-start time, so they all shared a timestamp and
  -- `viewed_at < last_viewed_at` was never going to hold — in the test. In
  -- production each open is its own transaction. Forcing the two apart tests
  -- the property that actually matters: a later open must not overwrite the
  -- first one.
  update quotes
     set viewed_at = now() - interval '9 days',
         last_viewed_at = now() - interval '9 days'
   where id = qid;

  perform sb_quote_public(tok, true);

  perform chk('THE POINT: a later open never overwrites viewed_at',
    (select viewed_at from quotes where id = qid) < now() - interval '8 days',
    'viewed_at is the first open and is what "sent, then read" is measured from');

  perform chk('...but last_viewed_at moves to the new one',
    (select last_viewed_at from quotes where id = qid) > now() - interval '1 minute',
    'a quote opened again after a week is a reason to call, and that needs both ends');

  perform chk('the count is never returned to the customer''s own page',
    not exists (
      select 1
        from information_schema.parameters
       where specific_name in (
               select specific_name from information_schema.routines
                where routine_name = 'sb_quote_public')
         and parameter_name = 'view_count'),
    'telling somebody "you have opened this 4 times" has no upside');

  -- A customer rereading a quote they already accepted is a real thing that
  -- happened, so it counts — but must not drag the status backwards.
  update quotes set status = 'accepted', accepted_at = now() where id = qid;
  perform sb_quote_public(tok, true);
  -- Five: three customer opens above, one more when viewed_at was backdated,
  -- and this one. The three PREVIEWS are not among them, which is the point.
  perform chk('an accepted quote still counts opens without changing status',
    (select status from quotes where id = qid) = 'accepted'
      and (select view_count from quotes where id = qid) = 5,
    format('status=%s view_count=%s',
           (select status from quotes where id = qid),
           (select view_count from quotes where id = qid)));

  update quotes set status = 'sent', accepted_at = null where id = qid;

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
end $$;

-- ---------------------------------------------------------------------------
-- Is db/quote-views.sql really safe to re-run?
-- ---------------------------------------------------------------------------
--
-- Every db/*.sql file claims to be. That claim is load-bearing — the
-- migration notes tell Jordan to re-run one whenever a later file clobbers
-- it — and for this one it is not free: the backfill sets view_count = 1 on
-- any quote with a viewed_at, which without its `and view_count = 0` guard
-- would reset a quote opened seven times back to one.
--
-- Mutation testing caught that the guard had no test: removing it changed
-- nothing and the suite still passed. So the migration is genuinely run a
-- second time, here, against a quote with a real count on it.
--
-- \i is relative to the working directory; run from the repo root as the
-- header says.

update quotes
   set viewed_at = now() - interval '3 days',
       last_viewed_at = now(),
       view_count = 7
 where id = '33333333-3333-3333-3333-333333333333';

\i db/quote-views.sql

do $$
begin
  perform chk('THE POINT: re-running the migration does not reset a real count',
    (select view_count from quotes
      where id = '33333333-3333-3333-3333-333333333333') = 7,
    format('view_count=%s — the backfill must only ever fill a zero',
           (select view_count from quotes
             where id = '33333333-3333-3333-3333-333333333333')));

  -- And the other direction: a row that predates the counter still gets its
  -- floor of 1, which is the whole reason the backfill exists.
  update quotes set view_count = 0, last_viewed_at = null
   where id = '33333333-3333-3333-3333-333333333333';
end $$;

\i db/quote-views.sql

do $$
begin
  perform chk('but a pre-counter row still gets its floor of one',
    (select view_count from quotes
      where id = '33333333-3333-3333-3333-333333333333') = 1);

  perform chk('and its last_viewed_at is seeded from the first open',
    (select last_viewed_at = viewed_at from quotes
      where id = '33333333-3333-3333-3333-333333333333'));

  raise notice '';
  raise notice 'all ok - p_mark holds';
end $$;
