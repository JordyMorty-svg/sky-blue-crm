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
      'runs against a scratch database built by verify/sms-fixture.sql.';
  end if;
end $$;

-- Assertions for db/lead-nudges.sql.
--
-- Run order: verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,
-- db/lead-ack.sql, verify/lead-nudge-fixture.sql, db/lead-nudges.sql, this.
--
-- WHAT THIS IS ACTUALLY CHECKING
-- ------------------------------
-- This sweep runs 1,440 times a day and starts conversations with customers
-- who did not ask for one. Every guard below is the difference between a
-- useful text and a complaint:
--
-- NOBODY ON THE BOARD TODAY IS TEXTED. The go-live date is the only thing
-- standing between running this migration and messaging every lead in
-- contacted, quoted and booked at once.
--
-- ONE TEXT PER VISIT. Quoting at the door moves a lead twice in ten minutes.
-- Three texts in forty-five minutes while you are still in the driveway is
-- the single most likely way this feature annoys somebody.
--
-- NO SECOND ROBOT ON TOP OF A FIRST. The website acknowledgment and the
-- contacted nudge say almost the same thing.
--
-- THE QUOTE TEXT WINS. If a real quote went out with a price and an accept
-- link, a plain-text approximation of it afterwards makes the business look
-- like it does not know what it has already said.
--
-- Checks marked THE POINT are the ones this file exists for.

-- THE TEST OWNS THE CLOCK, DELIBERATELY.
--
-- sb_lead_nudge_go_live() is stamped with the moment the migration ran, which
-- is seconds ago — so every event these tests write "20 minutes ago" would be
-- before it, and nothing would ever be due. Pinning it back makes the other
-- sections testable; section 2 pins it forward again to test the guard itself
-- on purpose.
create or replace function public.sb_lead_nudge_go_live()
returns timestamptz language sql immutable as $$ select now() - interval '30 days' $$;

create or replace function pg_temp.chk(what text, pass boolean, detail text default null)
returns void language plpgsql as $$
begin
  if pass then raise notice 'ok    %', what;
  else raise exception 'FAIL  %  %', what, coalesce('— ' || detail, '');
  end if;
end $$;

-- Puts a lead on the board as though somebody moved it `ago` ago.
--
-- It does NOT write the lead_event itself. db/lead-events.sql puts a
-- leads_status_change trigger on the table that writes one on insert, and the
-- first version of this helper added a second — so every lead had two events,
-- the newest was always stamped now(), and the fifteen-minute timer never
-- elapsed. Nothing was ever due and the suite said the migration was broken.
--
-- Letting the trigger do it and backdating afterwards also tests the real
-- path: a lead typed in at a door straight into 'contacted' gets its event
-- from that trigger, and that is the most common way one of these is created.
create or replace function pg_temp.moved(
  p_name text, p_status text, p_ago interval,
  p_phone text default '5415550101',
  p_estimate numeric default 400,
  p_appoint timestamptz default null,
  p_actor uuid default '22222222-2222-2222-2222-222222222222'
) returns uuid language plpgsql as $$
declare lid uuid;
begin
  perform set_config('test.uid', p_actor::text, true);

  insert into public.leads (name, phone, status, estimate, service, appointment_at, source)
  values (p_name, p_phone, p_status, p_estimate, 'Residential window washing',
          p_appoint, 'door')
  returning id into lid;

  update public.lead_events
     set created_at = now() - p_ago,
         changed_by = p_actor
   where lead_id = lid;

  return lid;
end $$;

-- Moves a lead already on the board, as though it happened `ago` ago.
--
-- Also lets the leads_status_change trigger write the event, for the same
-- reason moved() does. Writing one by hand leaves the trigger's own row
-- sitting there stamped now(), which is always the newest, so `distinct on`
-- picks it and the timer never elapses.
create or replace function pg_temp.move_to(
  p_lead uuid, p_status text, p_ago interval,
  p_actor uuid default '22222222-2222-2222-2222-222222222222'
) returns void language plpgsql as $$
begin
  perform set_config('test.uid', p_actor::text, true);
  update public.leads set status = p_status where id = p_lead;
  update public.lead_events
     set created_at = now() - p_ago, changed_by = p_actor
   where id = (select max(id) from public.lead_events where lead_id = p_lead);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The timer
-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  perform pg_temp.moved('Too soon', 'contacted', interval '5 minutes');
  select count(*) into n from public.sms_due_lead_nudges(50);
  perform pg_temp.chk('a lead moved 5 minutes ago is not due yet', n = 0, n::text);

  perform pg_temp.moved('Ready', 'contacted', interval '20 minutes');
  select count(*) into n from public.sms_due_lead_nudges(50)
   where out_name = 'Ready';
  perform pg_temp.chk('a lead moved 20 minutes ago is due', n = 1, n::text);

  perform pg_temp.moved('Ancient', 'contacted', interval '3 days');
  select count(*) into n from public.sms_due_lead_nudges(50) where out_name = 'Ancient';
  perform pg_temp.chk(
    'THE POINT: a move from three days ago has expired, not queued',
    n = 0,
    '"we have your details" three days late is worse than silence');

  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 2. No backfill
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
begin
  lid := pg_temp.moved('Before go-live', 'contacted', interval '20 minutes');

  -- Throw the switch AFTER the move, which is exactly what running the
  -- migration on a board that already has leads on it does.
  create or replace function public.sb_lead_nudge_go_live()
  returns timestamptz language sql immutable as $f$ select now() - interval '5 minutes' $f$;

  select count(*) into n from public.sms_due_lead_nudges(50);
  perform pg_temp.chk(
    'THE POINT: a lead moved before go-live is never texted',
    n = 0,
    'without this the first run messages everyone already on the board');

  -- And a move AFTER go-live is.
  --
  -- Both ends have to move, and the arithmetic is the point: a nudge needs an
  -- event OLDER than the 15 minute delay but NEWER than go-live, so with
  -- go-live 5 minutes ago no event can ever satisfy both. Pushing go-live
  -- back to 30 minutes opens a window the 16-minute-old event falls inside.
  create or replace function public.sb_lead_nudge_go_live()
  returns timestamptz language sql immutable as $f$ select now() - interval '30 minutes' $f$;
  update public.lead_events set created_at = now() - interval '16 minutes'
   where lead_id = lid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...but a move after it is', n = 1, n::text);

  -- Put the clock back for the rest of the file.
  create or replace function public.sb_lead_nudge_go_live()
  returns timestamptz language sql immutable as $f$ select now() - interval '30 days' $f$;

  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Only the latest status sends
-- ---------------------------------------------------------------------------

do $$
declare
  lid  uuid;
  kind text;
  n    int;
begin
  -- Quoted at the door: contacted 40 minutes ago, quoted 20 minutes ago.
  lid := pg_temp.moved('Driveway', 'contacted', interval '40 minutes');
  perform pg_temp.move_to(lid, 'quoted', interval '20 minutes');

  select count(*), min(out_kind) into n, kind
  from public.sms_due_lead_nudges(50) where out_lead_id = lid;

  perform pg_temp.chk('THE POINT: two moves in one visit produce ONE text', n = 1, n::text);
  perform pg_temp.chk('...and it is the one that is still true',
    kind = 'nudge_quoted', coalesce(kind, '(none)'));

  -- A lead that comes BACK to a status it already held.
  --
  -- This is what makes `distinct on` load-bearing rather than decorative.
  -- Requoted, or went quiet and got picked up again: the events read
  -- contacted, quoted, contacted, and the lead is on contacted. TWO of those
  -- events match `l.status = x.to_status`, so without distinct on the sweep
  -- gets the same lead twice, tries to send twice, and burns its limit on a
  -- message the dedupe index was always going to refuse.
  --
  -- Mutation testing found this: deleting distinct on left every other
  -- assertion in this file passing.
  perform pg_temp.move_to(lid, 'contacted', interval '18 minutes');
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk(
    'THE POINT: a lead that returns to a status appears once, not once per visit',
    n = 1, n || ' rows for one lead');

  -- A status changed without a matching event must not send a message about
  -- where the lead used to be. The trigger normally writes one, so this
  -- disables it to produce the state a bulk fix or a hand-edited row leaves
  -- behind: leads.status says one thing, the newest event says another.
  alter table public.leads disable trigger leads_status_change;
  update public.leads set status = 'booked' where id = lid;
  alter table public.leads enable trigger leads_status_change;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk(
    'THE POINT: an event that no longer matches the lead sends nothing',
    n = 0,
    'the event says quoted, the lead says booked — texting the stale one is a lie');

  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Nothing automatic on top of a recent text
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
begin
  lid := pg_temp.moved('Just acked', 'contacted', interval '20 minutes');

  -- The website acknowledgment, sent half an hour ago.
  insert into public.sms_messages (direction, phone, body, kind, lead_id, status, created_at)
  values ('out', '+15415550101', 'Thanks for reaching out', 'ack', lid, 'sent',
          now() - interval '30 minutes');

  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk(
    'THE POINT: no nudge on top of an acknowledgment sent half an hour ago',
    n = 0,
    'two near-identical robot texts in thirty minutes');

  -- A MANUAL text counts too. If somebody just typed this customer a real
  -- message, a robot following it up is worse than nothing.
  update public.sms_messages set kind = 'manual' where lead_id = lid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...and a manual text suppresses it just the same', n = 0, n::text);

  -- Old enough and the quiet period has passed.
  update public.sms_messages set created_at = now() - interval '2 days' where lead_id = lid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...but a text from two days ago does not', n = 1, n::text);

  -- An INBOUND text is not us talking. It should not suppress anything.
  update public.sms_messages set direction = 'in', created_at = now() - interval '5 minutes'
   where lead_id = lid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('an inbound reply does not count as us having texted them',
    n = 1, n::text);

  delete from public.leads;
  delete from public.sms_messages;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The quoted nudge yields to a real quote
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  qid uuid;
  n   int;
begin
  lid := pg_temp.moved('Quoted properly', 'quoted', interval '20 minutes');

  -- A quote that exists but was never sent should NOT suppress it.
  insert into public.quotes (token, lead_id, customer_name, amount, status, sent_at)
  values ('tok-draft', lid, 'Quoted properly', 400, 'draft', null)
  returning id into qid;

  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('a DRAFT quote does not count as having quoted them', n = 1, n::text);

  -- Sent. Now the nudge must stand down.
  update public.quotes set status = 'sent', sent_at = now() - interval '25 minutes'
   where id = qid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk(
    'THE POINT: a quote that was actually sent suppresses the quoted nudge',
    n = 0,
    'that text already carried the price and a link to accept on');

  -- Tested on sent_at, not on status, so a quote that was sent and then went
  -- anywhere else still counts as sent.
  update public.quotes set status = 'closed' where id = qid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...and still counts once the quote is closed', n = 0, n::text);

  update public.quotes set status = 'declined' where id = qid;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...or declined', n = 0, n::text);

  -- A sent quote on a DIFFERENT lead must not suppress this one.
  delete from public.quotes;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('a sent quote belonging to someone else does not suppress it',
    n = 1, n::text);

  -- ...and it does not touch the contacted or booked nudges at all.
  perform pg_temp.move_to(lid, 'contacted', interval '18 minutes');
  insert into public.quotes (token, lead_id, customer_name, amount, status, sent_at)
  values ('tok-sent2', lid, 'Quoted properly', 400, 'sent', now());
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('a sent quote does not suppress the CONTACTED nudge', n = 1, n::text);

  delete from public.quotes;
  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Booked needs a time
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
  appt timestamptz;
begin
  lid := pg_temp.moved('No time yet', 'booked', interval '20 minutes');
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk(
    'THE POINT: booked with no appointment sends nothing',
    n = 0,
    '"you''re booked in for null" is not a text anybody should receive');

  update public.leads set appointment_at = now() + interval '3 days' where id = lid;
  select count(*), min(out_appoint_at) into n, appt
  from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...and with one, it does', n = 1, n::text);
  perform pg_temp.chk('...carrying the appointment time to put in the message',
    appt is not null);

  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Who we will not text at all
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
begin
  perform pg_temp.moved('No phone', 'contacted', interval '20 minutes', null);
  select count(*) into n from public.sms_due_lead_nudges(50) where out_name = 'No phone';
  perform pg_temp.chk('a lead with no number is skipped', n = 0, n::text);

  perform pg_temp.moved('Half a number', 'contacted', interval '20 minutes', '541-730-359');
  select count(*) into n from public.sms_due_lead_nudges(50) where out_name = 'Half a number';
  perform pg_temp.chk('a half-typed number is skipped', n = 0, n::text);

  lid := pg_temp.moved('Said stop', 'contacted', interval '20 minutes', '5415550144');
  insert into public.sms_opt_outs (phone, source) values ('+15415550144', 'test')
  on conflict (phone) do nothing;
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('THE POINT: a number that replied STOP is never nudged', n = 0, n::text);

  -- Statuses that are not part of this.
  perform pg_temp.moved('Was lost', 'lost', interval '20 minutes', '5415550102');
  perform pg_temp.moved('Finished', 'completed', interval '20 minutes', '5415550103');
  perform pg_temp.moved('Scheduled', 'scheduled', interval '20 minutes', '5415550104');
  select count(*) into n from public.sms_due_lead_nudges(50)
   where out_name in ('Was lost', 'Finished', 'Scheduled');
  perform pg_temp.chk('lost, completed and scheduled are not nudged', n = 0, n::text);

  delete from public.leads;
  delete from public.sms_opt_outs;
end $$;

-- ---------------------------------------------------------------------------
-- 8. What the sweep is handed
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  perform pg_temp.moved('Dana Whitfield', 'quoted', interval '20 minutes',
                        '(541) 555-0188', 1910);
  select * into r from public.sms_due_lead_nudges(50) where out_name = 'Dana Whitfield';

  perform pg_temp.chk('the kind names the status it is about',
    r.out_kind = 'nudge_quoted', r.out_kind);
  perform pg_temp.chk('THE POINT: the number comes back in E.164, not as typed',
    r.out_phone = '+15415550188', coalesce(r.out_phone, '(null)'));
  perform pg_temp.chk('the estimate comes through for the message', r.out_estimate = 1910);
  perform pg_temp.chk('the service comes through', r.out_service is not null);
  perform pg_temp.chk('and the name of whoever moved it, so it can be signed',
    r.out_sender = 'Hayden Mortensen', coalesce(r.out_sender, '(null)'));

  delete from public.leads;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Never twice, and the key that enforces it
-- ---------------------------------------------------------------------------

do $$
declare
  lid uuid;
  n   int;
  ok1 boolean;
  ok2 boolean;
begin
  lid := pg_temp.moved('Once only', 'contacted', interval '20 minutes');

  -- The sweep sends it...
  select ok into ok1 from public.claim_sms(
    'nudge_contacted', '5415550101', 'first', lid, null, null, null, null, true);
  perform pg_temp.chk('the first nudge is claimed', ok1);

  -- ...and the index refuses a second, whatever the query thinks.
  select ok into ok2 from public.claim_sms(
    'nudge_contacted', '5415550101', 'second', lid, null, null, null, null, true);
  perform pg_temp.chk('THE POINT: a second nudge of the same kind is refused', not ok2);

  -- And the query stops offering it, so the sweep does not burn its limit.
  select count(*) into n from public.sms_due_lead_nudges(50) where out_lead_id = lid;
  perform pg_temp.chk('...and it stops appearing as due', n = 0, n::text);

  delete from public.leads;
  delete from public.sms_messages;
end $$;

-- Every kind the dedupe key knows about, after the rebuild. Leaving one out
-- breaks a feature nobody was changing — this is the check that would have
-- caught it the three previous times the column was rebuilt by hand.
do $$
declare
  lid uuid := gen_random_uuid();
  qid uuid := gen_random_uuid();
  jid uuid := gen_random_uuid();
begin
  perform pg_temp.chk('dedupe: quote',           public.sb_sms_dedupe_key('quote', null, qid, null) = 'quote:q:' || qid);
  perform pg_temp.chk('dedupe: nudge_sent',      public.sb_sms_dedupe_key('nudge_sent', null, qid, null) is not null);
  perform pg_temp.chk('dedupe: nudge_viewed',    public.sb_sms_dedupe_key('nudge_viewed', null, qid, null) is not null);
  perform pg_temp.chk('dedupe: reminder',        public.sb_sms_dedupe_key('reminder', null, null, jid) = 'reminder:j:' || jid);
  perform pg_temp.chk('dedupe: review',          public.sb_sms_dedupe_key('review', null, null, jid) = 'review:j:' || jid);
  perform pg_temp.chk('dedupe: ack',             public.sb_sms_dedupe_key('ack', lid, null, null) = 'ack:l:' || lid);
  perform pg_temp.chk('dedupe: nudge_contacted', public.sb_sms_dedupe_key('nudge_contacted', lid, null, null) = 'nudge_contacted:l:' || lid);
  perform pg_temp.chk('dedupe: nudge_quoted',    public.sb_sms_dedupe_key('nudge_quoted', lid, null, null) = 'nudge_quoted:l:' || lid);
  perform pg_temp.chk('dedupe: nudge_booked',    public.sb_sms_dedupe_key('nudge_booked', lid, null, null) = 'nudge_booked:l:' || lid);
  perform pg_temp.chk('THE POINT: a hand-typed text is still never deduplicated',
    public.sb_sms_dedupe_key('manual', lid, null, null) is null,
    'a person typing a second message to the same customer is not a bug');
end $$;

do $$
declare pred text;
begin
  select pg_get_expr(i.indpred, i.indrelid) into pred
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where c.relname = 'sms_messages_dedupe_idx';
  perform pg_temp.chk(
    'THE POINT: the dedupe index still covers undelivered rows',
    pred like '%undelivered%',
    'ON CONFLICT with no matching index raises, and EVERY text the CRM sends fails');
end $$;

do $$
begin
  raise notice '';
  raise notice 'all ok — the board nudges hold';
end $$;
