-- psql keeps going after an error unless it is told not to, so this comes
-- before the guard rather than after it.
\set ON_ERROR_STOP on

-- ###########################################################################
-- #  THIS FILE DELETES ROWS. It is for a THROWAWAY Postgres, never for      #
-- #  Supabase. db/*.sql are the real migrations; verify/*.sql are not.      #
-- ###########################################################################

do $$
begin
  if to_regclass('public._scratch_db') is null then
    raise exception
      'REFUSING TO RUN. This is a verify/ file and it deletes rows. It only '
      'runs against a scratch database built by the matching '
      'verify/*-fixture.sql, which creates public._scratch_db. If you meant '
      'to apply a migration, the file you want is in db/.';
  end if;
end $$;

-- Assertions for db/delivery-controls.sql.
--
-- What this is actually checking
-- ------------------------------
-- One thing above all others: that CONFIRMING A DELIVERY CANNOT CAUSE A
-- SECOND SEND.
--
-- The obvious way to record "it arrived" is a 'delivered' status. It is a
-- trap. The double-send guard is a unique index over
--
--     status in ('queued', 'sent', 'undelivered')
--
-- so a row that moved to 'delivered' would drop OUT of it and free the
-- dedupe slot — and the nightly run would send the same quote again, to
-- somebody who has already read it. Nothing errors. The customer just gets
-- the quote twice, and then again, every night.
--
-- That is why delivery is a timestamp. The assertions marked THE POINT are
-- the ones that would notice if it ever became a status again.

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
-- Confirming delivery must not free the dedupe slot
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead uuid;
  v_q    uuid;
  v_id   bigint;
  n      int;
begin
  delete from public.sms_messages where phone = '+15415559001';
  delete from public.quotes where token = 'tok-dc-1';
  delete from public.leads  where name = 'Delivered Guard Test';

  insert into public.leads (name, phone)
  values ('Delivered Guard Test', '+15415559001')
  returning id into v_lead;

  insert into public.quotes (token, lead_id, customer_name, amount, status, sent_at)
  values ('tok-dc-1', v_lead, 'Delivered Guard Test', 400, 'sent', now())
  returning id into v_q;

  insert into public.sms_messages
    (direction, kind, phone, body, status, quote_id, lead_id, provider_sid, sent_at)
  values ('out', 'quote', '+15415559001', 'your quote', 'sent',
          v_q, v_lead, 'quo-dc-1', now())
  returning id into v_id;

  perform chk('a sent text is recorded', v_id is not null);

  perform public.mark_sms_delivered('quo-dc-1');

  perform chk('delivery is recorded',
              (select delivered_at from public.sms_messages where id = v_id) is not null);

  -- THE POINT. If delivery had been recorded as a status, the row would now
  -- be outside the dedupe index and this insert would succeed.
  perform chk('THE POINT: a delivered text still holds its dedupe slot',
              (select status from public.sms_messages where id = v_id) = 'sent');

  begin
    insert into public.sms_messages
      (direction, kind, phone, body, status, quote_id, lead_id)
    values ('out', 'quote', '+15415559001', 'your quote again', 'queued',
            v_q, v_lead);
    perform chk('THE POINT: a delivered quote cannot be sent a second time',
                false, 'the duplicate insert was ACCEPTED');
  exception when unique_violation then
    perform chk('THE POINT: a delivered quote cannot be sent a second time', true);
  end;

  -- Idempotent: the webhook and the reconciler will both report the same
  -- message, and only the first one may change anything.
  perform chk('a second delivery report changes nothing',
              public.mark_sms_delivered('quo-dc-1') is not true);

  -- And once confirmed, it stops being asked about — the entire point of
  -- recording it at all.
  select count(*) into n from public.sms_awaiting_verdict(100, 7)
   where out_sid = 'quo-dc-1';
  perform chk('THE POINT: a confirmed text is not asked about again', n = 0, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- Which sends Quo gets asked about
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead uuid;
  n      int;
begin
  delete from public.sms_messages where phone in ('+15415559002', '+15415559003');
  delete from public.leads where name = 'Verdict Window Test';

  insert into public.leads (name, phone)
  values ('Verdict Window Test', '+15415559002')
  returning id into v_lead;

  -- Recent, sent, unconfirmed: exactly the case.
  insert into public.sms_messages
    (direction, kind, phone, body, status, lead_id, provider_sid, sent_at)
  values ('out', 'quote', '+15415559002', 'a', 'sent', v_lead, 'quo-dc-recent', now());

  select count(*) into n from public.sms_awaiting_verdict(100, 7)
   where out_sid = 'quo-dc-recent';
  perform chk('a recent unconfirmed text is asked about', n = 1, n::text);

  -- Too old. Quo's answer stopped changing days ago, and asking forever is a
  -- request per message per night for an answer nobody is waiting for.
  update public.sms_messages
     set created_at = now() - interval '30 days'
   where provider_sid = 'quo-dc-recent';

  select count(*) into n from public.sms_awaiting_verdict(100, 7)
   where out_sid = 'quo-dc-recent';
  perform chk('an old text is not asked about forever', n = 0, n::text);

  update public.sms_messages
     set created_at = now() where provider_sid = 'quo-dc-recent';

  -- No provider id means there is nothing to ask ABOUT. A send that failed
  -- before Quo answered has none.
  insert into public.sms_messages
    (direction, kind, phone, body, status, lead_id, sent_at)
  values ('out', 'quote', '+15415559003', 'b', 'sent', v_lead, now());

  select count(*) into n from public.sms_awaiting_verdict(100, 7)
   where out_sid is null;
  perform chk('a send with no Quo id is not asked about', n = 0, n::text);

  -- An already-failed row is settled. Asking again would be asking Quo to
  -- overturn a verdict we already have.
  update public.sms_messages
     set status = 'undelivered', error = 'destination not found'
   where provider_sid = 'quo-dc-recent';

  select count(*) into n from public.sms_awaiting_verdict(100, 7)
   where out_sid = 'quo-dc-recent';
  perform chk('a text already known to have failed is not re-asked', n = 0, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- Clearing the list
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead uuid;
  v_id   bigint;
  n      int;
begin
  delete from public.sms_messages where phone = '+15415559004';
  delete from public.leads where name = 'Dismiss Test';

  insert into public.leads (name, phone)
  values ('Dismiss Test', '+15415559004')
  returning id into v_lead;

  insert into public.sms_messages
    (direction, kind, phone, body, status, lead_id, error)
  values ('out', 'quote', '+15415559004', 'c', 'undelivered', v_lead,
          'destination not found')
  returning id into v_id;

  select count(*) into n from public.delivery_failures where id = v_id::text;
  perform chk('a failure is on the list', n = 1, n::text);

  perform chk('dismissing it works',
              public.dismiss_sms_failure(v_id, '11111111-1111-1111-1111-111111111111'));

  select count(*) into n from public.delivery_failures where id = v_id::text;
  perform chk('and it leaves the list', n = 0, n::text);

  -- THE POINT. The screen was tidied; the record of what this business sent
  -- to which number is what answers a carrier complaint, and it must still
  -- be there.
  perform chk('THE POINT: dismissing does NOT delete the message',
              exists (select 1 from public.sms_messages where id = v_id));
  perform chk('and records who cleared it',
              (select dismissed_by from public.sms_messages where id = v_id)
              = '11111111-1111-1111-1111-111111111111');

  select count(*) into n from public.delivery_dismissed where id = v_id::text;
  perform chk('THE POINT: and it is still findable', n = 1, n::text);

  perform chk('dismissing twice changes nothing',
              public.dismiss_sms_failure(v_id) is not true);

  perform chk('it can be put back', public.undismiss_sms_failure(v_id));
  select count(*) into n from public.delivery_failures where id = v_id::text;
  perform chk('and returns to the list', n = 1, n::text);

  -- A healthy send is not dismissable. Hiding one would silently mark a
  -- message that arrived as something somebody had dealt with.
  update public.sms_messages set status = 'sent' where id = v_id;
  perform chk('THE POINT: a message that went through cannot be dismissed',
              public.dismiss_sms_failure(v_id) is not true);
end $$;

-- ---------------------------------------------------------------------------
-- Rows belonging to a record that no longer exists
-- ---------------------------------------------------------------------------
--
-- The eight "Unknown" rows on Jordan's screen: test sends whose leads were
-- deleted months ago. quotes cascade when a lead goes; sms_messages
-- deliberately does not — it nulls the links — so what is left is a failure
-- row with no name, no record to open, and nothing anybody can do with it.

do $$
declare
  v_lead uuid;
  v_id   bigint;
  n      int;
begin
  delete from public.sms_messages where phone = '+15415559005';
  delete from public.leads where name = 'Orphan Test';

  insert into public.leads (name, phone)
  values ('Orphan Test', '+15415559005')
  returning id into v_lead;

  insert into public.sms_messages
    (direction, kind, phone, body, status, lead_id, error)
  values ('out', 'quote', '+15415559005', 'd', 'failed', v_lead,
          'The organization is not approved for A2P')
  returning id into v_id;

  select count(*) into n from public.delivery_failures where id = v_id::text;
  perform chk('a failure with a live lead is on the list', n = 1, n::text);

  delete from public.leads where id = v_lead;

  -- The message survives the lead, on purpose: the record that this number
  -- was texted has to outlive the tidying up.
  perform chk('the message outlives the lead',
              exists (select 1 from public.sms_messages where id = v_id));

  -- THE POINT. But it is not a task. It has no name, no record to open, and
  -- nothing to do about it.
  select count(*) into n from public.delivery_failures where id = v_id::text;
  perform chk('THE POINT: but it drops off the list with the lead', n = 0, n::text);
end $$;

-- ---------------------------------------------------------------------------
-- Deleting a quote
-- ---------------------------------------------------------------------------

do $$
declare
  v_lead uuid;
  v_q    uuid;
  v_sms  bigint;
  n      int;
  caught boolean := false;
begin
  delete from public.sms_messages where phone = '+15415559006';
  delete from public.quotes where token in ('tok-del-1', 'tok-del-2');
  delete from public.leads where name = 'Quote Delete Test';

  insert into public.leads (name, phone)
  values ('Quote Delete Test', '+15415559006')
  returning id into v_lead;

  insert into public.quotes (token, lead_id, customer_name, amount, status, sent_at)
  values ('tok-del-1', v_lead, 'Quote Delete Test', 250, 'sent', now())
  returning id into v_q;

  insert into public.sms_messages
    (direction, kind, phone, body, status, quote_id, lead_id)
  values ('out', 'quote', '+15415559006', 'e', 'sent', v_q, v_lead)
  returning id into v_sms;

  perform chk('a sent quote can be deleted', public.delete_quote(v_q));
  perform chk('and is gone',
              not exists (select 1 from public.quotes where id = v_q));

  -- THE POINT. The quote goes; the record that this number was texted stays,
  -- unlinked. Cascading here would take the opt-out and complaint history
  -- with it.
  perform chk('THE POINT: the text about it survives, unlinked',
              exists (select 1 from public.sms_messages
                       where id = v_sms and quote_id is null));

  perform chk('deleting it again is not an error',
              public.delete_quote(v_q) is not true);

  -- An accepted quote has a job and a booking fee hanging off it.
  insert into public.quotes
    (token, lead_id, customer_name, amount, status, sent_at, accepted_at)
  values ('tok-del-2', v_lead, 'Quote Delete Test', 600, 'accepted', now(), now())
  returning id into v_q;

  begin
    perform public.delete_quote(v_q);
  exception when others then
    caught := true;
  end;

  -- THE POINT, and the whole reason this goes through a function instead of
  -- a DELETE from the browser. Deleting an accepted quote removes the
  -- evidence of a payment somebody is owed, from the person who is owed it,
  -- with the job still on the calendar.
  perform chk('THE POINT: an accepted quote is refused', caught);
  perform chk('and is still there',
              exists (select 1 from public.quotes where id = v_q));

  select count(*) into n from public.quotes where token = 'tok-del-2';
  perform chk('exactly one, untouched', n = 1, n::text);
end $$;

-- ---------------------------------------------------------------------------

do $$
declare
  bad int;
begin
  select failed into bad from _score;
  if bad > 0 then
    raise exception '% assertion(s) failed', bad;
  end if;
  raise notice '--- all assertions passed ---';
end $$;
