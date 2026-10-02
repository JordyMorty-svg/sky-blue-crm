-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it.
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
      'runs against a scratch database built by verify/quotes-fixture.sql, '
      'which creates public._scratch_db. If you meant to apply a migration, '
      'the file you want is in db/.';
  end if;
end $$;

-- Assertions for db/quote-close.sql.
--
-- Run against a THROWAWAY Postgres:
--   psql -d scratch -f verify/quotes-fixture.sql
--   psql -d scratch -f db/quotes.sql
--   psql -d scratch -f db/quote-close.sql
--   psql -d scratch -f verify/quote-close.sql
--
-- What this is actually checking
-- ------------------------------
-- One thing above all others: A CLOSED QUOTE CANNOT BE ACCEPTED.
--
-- A quote link is a standing offer. The token keeps working after the work
-- has been done and billed some other way, and anyone holding that text
-- message can open it months later. Hiding the Accept button is not a
-- defence — that is a button, and acceptance is an endpoint. If
-- sb_accept_quote will still take a closed quote, this feature is a label on
-- a door that is still open.
--
-- The assertions marked THE POINT are the ones that would notice.

do $$
declare
  lead_id uuid;
  q_open  uuid;
  q_view  uuid;
  q_acc   uuid;
  tok     text;
  r       record;
  n       int;
  s       text;
begin
  insert into public.leads (name, address, status)
  values ('Jeff Krueger', '1 Test St', 'quoted')
  returning id into lead_id;

  -- The $1,800 pressure wash: sent, never opened.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 1800, 'sent', 'tok_open', now())
  returning id into q_open;

  -- One they did open and then went quiet on.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at, viewed_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 950, 'viewed', 'tok_view', now(), now())
  returning id into q_view;

  -- And one they accepted. A job and a booking fee hang off this.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at, accepted_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 1180, 'accepted', 'tok_acc', now(), now())
  returning id into q_acc;

  -- =========================================================================
  -- Closing
  -- =========================================================================

  perform public.close_quote(q_open, 'Superseded — billed as one job');

  select status into s from public.quotes where id = q_open;
  assert s = 'closed', format('a sent quote should close, got %s', s);
  raise notice 'ok    a sent-but-never-opened quote can be closed';

  assert (select closed_at is not null from public.quotes where id = q_open),
    'closing should stamp closed_at';
  raise notice 'ok    and records when';

  select closed_reason into s from public.quotes where id = q_open;
  assert s = 'Superseded — billed as one job',
    format('the reason should be kept, got %s', coalesce(s, 'null'));
  raise notice 'ok    and why, when a reason is given';

  -- A quote they opened and ignored needs closing just as much.
  perform public.close_quote(q_view, null);
  select status into s from public.quotes where id = q_view;
  assert s = 'closed', format('a viewed quote should close too, got %s', s);
  raise notice 'ok    a quote they opened and ignored can be closed';

  select closed_reason into s from public.quotes where id = q_view;
  assert s is null, format('a blank reason should stay null, got %s', s);
  raise notice 'ok    and a reason is optional';

  -- Closing twice is not an error. Two taps on a phone, one outcome.
  perform public.close_quote(q_open, null);
  select status into s from public.quotes where id = q_open;
  assert s = 'closed', 'closing twice should be a no-op, not a failure';
  raise notice 'ok    closing twice changes nothing and raises nothing';

  -- THE REFUSAL. Accepting is what created the job and what the commission
  -- trigger reads to decide who is owed the booking fee.
  begin
    perform public.close_quote(q_acc, null);
    assert false, 'THE POINT: an accepted quote must not be closeable';
  exception
    when others then
      assert sqlerrm like '%accepted%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: an accepted quote is refused';
  end;

  select status into s from public.quotes where id = q_acc;
  assert s = 'accepted', 'and the accepted quote is untouched';
  raise notice 'ok    and it is left exactly as it was';

  -- =========================================================================
  -- THE POINT OF THE WHOLE FEATURE: the offer stops
  -- =========================================================================

  select * into r from public.sb_accept_quote('tok_open');
  assert r.ok = false,
    'THE POINT: a closed quote must not be acceptable from its public link';
  assert r.reason = 'closed',
    format('the refusal should say why, got %s', r.reason);
  raise notice 'ok    THE POINT: a closed quote cannot be accepted from its link';

  select status into s from public.quotes where id = q_open;
  assert s = 'closed', 'and the attempt did not change it';
  raise notice 'ok    and the attempt leaves it closed';

  -- The lead must not have been dragged to booked by the attempt.
  select status into s from public.leads where id = lead_id;
  assert s <> 'booked',
    'THE POINT: a refused acceptance must not move the lead';
  raise notice 'ok    THE POINT: and the lead is not moved by a refused accept';

  -- =========================================================================
  -- Every other refusal still works
  -- =========================================================================
  --
  -- db/quote-close.sql reproduces the whole of sb_accept_quote to add one
  -- guard. These are the guards that would vanish quietly.

  select * into r from public.sb_accept_quote('tok_nonsense');
  assert r.ok = false and r.reason = 'not_found',
    format('an unknown token should be not_found, got %s', r.reason);
  raise notice 'ok    an unknown token is still refused';

  select * into r from public.sb_accept_quote('tok_acc');
  assert r.ok = true and r.reason = 'already_accepted' and r.already = true,
    format('re-accepting should be idempotent, got %s', r.reason);
  raise notice 'ok    re-accepting an accepted quote is still idempotent';

  -- Expiry.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at, expires_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 600, 'sent', 'tok_old', now(), now() - interval '1 day');
  select * into r from public.sb_accept_quote('tok_old');
  assert r.ok = false and r.reason = 'expired',
    format('an expired quote should still be refused, got %s', r.reason);
  raise notice 'ok    an expired quote is still refused';

  -- Declined.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at, declined_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 700, 'declined', 'tok_no', now(), now());
  select * into r from public.sb_accept_quote('tok_no');
  assert r.ok = false and r.reason = 'declined',
    format('a declined quote should still be refused, got %s', r.reason);
  raise notice 'ok    a declined quote is still refused';

  -- And a healthy one still goes through, moving the lead and taking the
  -- amount with it. This is the assertion that would catch the whole
  -- function being replaced by refusals.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 2400, 'sent', 'tok_good', now());
  select * into r from public.sb_accept_quote('tok_good');
  assert r.ok = true and r.reason = 'accepted',
    format('a live quote should still be acceptable, got %s', r.reason);
  raise notice 'ok    THE POINT: a live quote can still be accepted';

  select status, estimate::int into s, n from public.leads where id = lead_id;
  assert s = 'booked', format('accepting should still book the lead, got %s', s);
  assert n = 2400, format('and carry the agreed amount, got %s', n);
  raise notice 'ok    and it still books the lead at the agreed amount';

  -- =========================================================================
  -- Reopening
  -- =========================================================================

  perform public.reopen_quote(q_open);
  select status into s from public.quotes where id = q_open;
  assert s = 'sent',
    format('a never-opened quote should reopen to sent, got %s', s);
  raise notice 'ok    a closed quote reopens';

  assert (select closed_at is null and closed_reason is null
            from public.quotes where id = q_open),
    'reopening should clear what closing wrote';
  raise notice 'ok    and the closing is cleared, not left behind';

  perform public.reopen_quote(q_view);
  select status into s from public.quotes where id = q_view;
  assert s = 'viewed',
    format('THE POINT: a quote they had opened must reopen to viewed, got %s', s);
  raise notice 'ok    THE POINT: one they had read reopens to viewed, not sent';

  -- And once reopened it is acceptable again.
  select * into r from public.sb_accept_quote('tok_open');
  assert r.ok = true, format('a reopened quote should be acceptable, got %s', r.reason);
  raise notice 'ok    and a reopened quote can be accepted again';

  begin
    perform public.reopen_quote(q_acc);
    assert false, 'reopening a quote that is not closed should be refused';
  exception
    when others then
      assert sqlerrm like '%not closed%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    reopening one that was never closed is refused';
  end;

  -- =========================================================================
  -- The nudges stop
  -- =========================================================================
  --
  -- sms_due_quote_nudges filters `status in ('sent','viewed')` -- an
  -- allowlist -- so closing excludes a quote for free. Asserted anyway,
  -- because "for free" is exactly the kind of behaviour that gets rewritten
  -- into a denylist by somebody adding a state later.

  if to_regprocedure('public.sms_due_quote_nudges(int)') is not null then
    perform public.close_quote(q_open, null);
    select count(*) into n
    from public.sms_due_quote_nudges(50) x
    where x.quote_id = q_open;
    assert n = 0,
      format('THE POINT: a closed quote must not be chased, got %s', n);
    raise notice 'ok    THE POINT: a closed quote is not nudged';
  else
    raise notice 'skip  nudges (db/quote-sender-name.sql not loaded in this chain)';
  end if;

  raise notice '--- all assertions passed ---';
end $$;
