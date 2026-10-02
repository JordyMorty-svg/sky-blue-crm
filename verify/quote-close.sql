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
  s2      text;
  the_job uuid;
  other_job uuid;
  other_lead uuid;
  job_ref uuid;
  del_ok  boolean;
  q_free  uuid;
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
  -- Closing, with a reason
  -- =========================================================================

  perform public.close_quote(q_open, 'done_elsewhere', null, 'Rolled into the $3,280 job');

  select status into s from public.quotes where id = q_open;
  assert s = 'closed', format('a sent quote should close, got %s', s);
  raise notice 'ok    a sent-but-never-opened quote can be closed';

  select closed_reason into s from public.quotes where id = q_open;
  assert s = 'done_elsewhere', format('the reason should be kept, got %s', s);
  raise notice 'ok    and the reason is recorded as a code, not prose';

  select closed_note into s from public.quotes where id = q_open;
  assert s = 'Rolled into the $3,280 job', format('the note should be kept, got %s', coalesce(s,'null'));
  raise notice 'ok    alongside whatever was typed';

  assert (select closed_at is not null from public.quotes where id = q_open),
    'closing should stamp closed_at';
  raise notice 'ok    and when';

  -- A reason is not optional. "Closed" with no why is the thing this
  -- feature exists to stop.
  begin
    perform public.close_quote(q_view, null, null, null);
    assert false, 'THE POINT: closing without a reason must be refused';
  exception
    when others then
      assert sqlerrm like '%reason%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: closing with no reason is refused';
  end;

  begin
    perform public.close_quote(q_view, 'because_i_said_so', null, null);
    assert false, 'an unknown reason code must be refused';
  exception
    when others then
      raise notice 'ok    and so is a reason nobody defined';
  end;

  perform public.close_quote(q_view, 'no_response', null, null);
  select status, closed_reason into s, s2 from public.quotes where id = q_view;
  assert s = 'closed' and s2 = 'no_response',
    format('a viewed quote should close, got %s / %s', s, s2);
  raise notice 'ok    a quote they opened and ignored can be closed';

  -- Closing twice is not an error, and the second reason wins — somebody
  -- correcting a mis-picked reason should not have to reopen first.
  perform public.close_quote(q_view, 'went_elsewhere', null, null);
  select closed_reason into s from public.quotes where id = q_view;
  assert s = 'went_elsewhere', format('the reason should be correctable, got %s', s);
  raise notice 'ok    closing twice corrects the reason rather than failing';

  -- THE REFUSAL. Accepting is what created the job and what the commission
  -- trigger reads to decide who is owed the booking fee.
  begin
    perform public.close_quote(q_acc, 'no_response', null, null);
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
  -- Linking the job the work was actually done on
  -- =========================================================================

  insert into public.jobs (lead_id, status, price, final_price)
  values (lead_id, 'completed', 3280, 3280) returning id into the_job;

  perform public.close_quote(q_open, 'done_elsewhere', the_job, null);
  select closed_job_id into job_ref from public.quotes where id = q_open;
  assert job_ref = the_job, 'the job should be linked';
  raise notice 'ok    a quote closed as done elsewhere can name the job';

  -- A job may only hang off the ending that means one.
  begin
    perform public.close_quote(q_view, 'no_response', the_job, null);
    assert false, 'THE POINT: a job must not attach to an ending that means no work happened';
  exception
    when others then
      assert sqlerrm like '%done on another job%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: a job cannot be linked to "never heard back"';
  end;

  -- And it has to be this customer's job.
  insert into public.leads (name, address, status)
  values ('Someone Else', '9 Other St', 'quoted') returning id into other_lead;
  insert into public.jobs (lead_id, status, price)
  values (other_lead, 'completed', 100) returning id into other_job;

  begin
    perform public.close_quote(q_open, 'done_elsewhere', other_job, null);
    assert false, 'THE POINT: another customer''s job must not be linkable';
  exception
    when others then
      assert sqlerrm like '%different customer%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: and not somebody else''s job';
  end;

  -- Changing the reason away from done_elsewhere drops the link, so a row
  -- can never say the work was done AND name no job, or the reverse.
  perform public.close_quote(q_open, 'no_response', null, null);
  select closed_job_id into job_ref from public.quotes where id = q_open;
  assert job_ref is null, 'changing the reason should drop a stale job link';
  raise notice 'ok    changing the reason drops a link that no longer applies';
  perform public.close_quote(q_open, 'done_elsewhere', the_job, null);

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
  -- A quote attached to a job cannot be deleted
  -- =========================================================================
  --
  -- It is the only surviving statement of what that work was quoted at.
  -- Deleting it leaves a job with a price and nothing explaining it.
  --
  -- Every refusal below is caught in its OWN nested block. An exception
  -- handler on the outermost BEGIN rolls the whole block back to its start —
  -- so catching one here would silently discard the lead and the three
  -- quotes this file spent fifty lines setting up, and everything after it
  -- would fail on a null lead_id. That is what the first draft did.

  begin
    perform public.delete_quote(q_open);
    assert false, 'THE POINT: a quote linked to a job must not be deletable';
  exception
    when others then
      assert sqlerrm like '%attached to a job%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: a quote attached to a job cannot be deleted';
  end;

  select id into job_ref from public.quotes where id = q_open;
  assert job_ref = q_open, 'and the quote is still there';
  raise notice 'ok    and it is still there';

  -- Closed with no job linked: still deletable. Refusing on the strength of
  -- a reason code alone would be stricter than the record justifies.
  insert into public.quotes (lead_id, customer_name, address, amount, status, token, sent_at)
  values (lead_id, 'Jeff Krueger', '1 Test St', 300, 'sent', 'tok_free', now())
  returning id into q_free;
  perform public.close_quote(q_free, 'done_elsewhere', null, null);

  select public.delete_quote(q_free) into del_ok;
  assert del_ok, 'a closed quote with no job linked should still delete';
  raise notice 'ok    one closed with no job linked still deletes';

  -- The two original refusals still work.
  begin
    perform public.delete_quote(q_acc);
    assert false, 'an accepted quote must still refuse deletion';
  exception
    when others then
      assert sqlerrm like '%accepted%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    an accepted quote still refuses deletion';
  end;

  select public.delete_quote(gen_random_uuid()) into del_ok;
  assert del_ok = false, 'deleting a quote that is already gone is not an error';
  raise notice 'ok    deleting one that is already gone is still not an error';

  -- =========================================================================
  -- Reopening, and the endings that are final
  -- =========================================================================

  -- q_view is closed as went_elsewhere: they engaged and said no. They might
  -- ring in March.
  perform public.reopen_quote(q_view);
  select status into s from public.quotes where id = q_view;
  assert s = 'viewed',
    format('THE POINT: a quote they had opened must reopen to viewed, got %s', s);
  raise notice 'ok    THE POINT: one they had read reopens to viewed, not sent';

  assert (select closed_at is null and closed_reason is null and closed_note is null
            from public.quotes where id = q_view),
    'reopening should clear what closing wrote';
  raise notice 'ok    and the closing is cleared, not left behind';

  -- q_open is closed as done_elsewhere. The work HAPPENED. There is nothing
  -- to reopen, and reopening it would put a live offer in front of somebody
  -- for work they have already paid for.
  begin
    perform public.reopen_quote(q_open);
    assert false, 'THE POINT: a quote closed because the work was done must not reopen';
  exception
    when others then
      assert sqlerrm like '%settled by something else%', format('wrong refusal: %s', sqlerrm);
      raise notice 'ok    THE POINT: one closed because the work was done cannot reopen';
  end;

  -- Same for a quote replaced by a corrected one: reopening would leave two
  -- live quotes in front of the same customer.
  perform public.close_quote(q_view, 'requoted', null, null);
  begin
    perform public.reopen_quote(q_view);
    assert false, 'a re-quoted quote must not reopen';
  exception
    when others then
      raise notice 'ok    nor one that was superseded by a re-quote';
  end;

  -- A never-opened quote that simply went quiet reopens to sent.
  perform public.close_quote(q_view, 'no_response', null, null);
  perform public.reopen_quote(q_view);
  select status into s from public.quotes where id = q_view;
  assert s = 'viewed', format('it had been viewed, so it returns to viewed, got %s', s);
  raise notice 'ok    and one that merely went quiet reopens';

  -- Reopened, it can be accepted again.
  select * into r from public.sb_accept_quote('tok_view');
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
    perform public.close_quote(q_view, 'no_response', null, null);
    select count(*) into n
    from public.sms_due_quote_nudges(50) x
    where x.quote_id = q_view;
    assert n = 0,
      format('THE POINT: a closed quote must not be chased, got %s', n);
    raise notice 'ok    THE POINT: a closed quote is not nudged';
  else
    raise notice 'skip  nudges (db/quote-sender-name.sql not loaded in this chain)';
  end if;

  raise notice '--- all assertions passed ---';
end $$;
