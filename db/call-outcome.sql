-- Sky Blue CRM — what Quo actually says when a call ends
--
-- Run AFTER db/call-tracking.sql and db/call-notes.sql.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- db/call-tracking.sql guessed at Quo's vocabulary. It decided a call had
-- happened when the status was one of `answered`, `forwarded`, `unanswered`,
-- `no-answer`, `noanswer` or `missed`, and that somebody had picked up when
-- the status was `answered` or `forwarded` AND the duration was ten seconds
-- or more.
--
-- Quo does not say any of that for a completed call. The live webhook, read
-- off the Netlify log on 6 Oct:
--
--     [quo-calls] NOT recorded — either a repeat, an outcome we don't log,
--     or a number with no lead or customer in the CRM {
--       type: 'call.completed',
--       id: 'AC-example-call-id',
--       direction: 'outgoing',
--       status: 'completed',      <-- not in the list above
--       duration: null,           <-- and no duration to fall back on
--       who: '3646'
--     }
--
-- Quo's own API, asked about that same call afterwards, reports it as
-- `completed` with a duration of 17s. So `completed` is the normal terminal
-- status for a call that ran, and **call.completed can arrive before the
-- duration is known**. Unanswered inbound calls come through as `no-answer`
-- with a duration of 0.
--
-- Three changes follow from that.
--
-- 1. THE GATE IS INVERTED. It used to list the statuses that count and drop
--    everything else. One word Quo had not been guessed — the most common
--    one — and every call vanished with a log line saying it might be a
--    duplicate. Now the statuses that mean NO CALL HAPPENED are listed, and
--    anything else is written down. A vocabulary we have not seen is a row
--    somebody can look at and query, not silence.
--
-- 2. "ANSWERED" IS A FACT FROM THE PAYLOAD, NOT A WORD IN THE STATUS. The
--    webhook now reads `answeredAt` and passes it as p_answered, and derives
--    a duration from `completedAt - answeredAt` when Quo has not computed
--    one. The database no longer has to recognise a word to know somebody
--    picked up.
--
-- 3. A CALL CAN BE RECLASSIFIED. When call.completed carries no duration,
--    the row is written as an attempt and the transcript — which does carry
--    one — upgrades it. refresh_call_detail() does that, so it happens on
--    the path that already existed and nothing new has to be remembered.

-- NO REAL QUO CALL IDS IN THIS REPO.
--
-- A Quo call id is `AC` followed by 32 hex characters, which is exactly the
-- shape of a Twilio Account SID — Quo is built on Twilio. GitHub's push
-- protection matches that shape and rejects the push, and it is right to:
-- it cannot tell one from the other, and this repository is public.
--
-- The ids below are deliberately not that shape. If you paste a real one in
-- from a log, the push will be blocked and the fix will be this comment.

do $$
begin
  if to_regclass('public.call_notes') is null then
    raise exception
      'Run db/call-tracking.sql and db/call-notes.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Did somebody pick up?
-- ---------------------------------------------------------------------------
--
-- The old two-argument form is dropped rather than left beside this one.
-- Two functions with the same name, one of which quietly answers a different
-- question, is how half the callers end up on the wrong one.
drop function if exists public.sb_call_connected(text, integer);

create or replace function public.sb_call_connected(
  p_status   text,
  p_duration integer,
  -- Did Quo stamp an answeredAt on it? Null means the payload did not say,
  -- which is not the same as "no" and must not be read as one.
  p_answered boolean default null
)
returns boolean
language sql
immutable
as $$
  select case
    -- Quo said in so many words that nobody picked up. Nothing else matters,
    -- including a duration, which for these is the RING time.
    when lower(coalesce(p_status, '')) in
         ('no-answer', 'noanswer', 'missed', 'unanswered', 'abandoned')
      then false

    -- The payload carried no answeredAt. That is Quo saying the call was
    -- never picked up, in the one field that always carries the fact.
    when p_answered is false then false

    -- The payload carried one, but call.completed had not worked out the
    -- duration yet — which is what Quo's live webhook does. An answeredAt is
    -- an answer; if it turns out to have been four seconds, the transcript
    -- arrives with a real duration and refresh_call_detail() demotes it.
    when p_answered and p_duration is null then true

    -- Picked up, and we know for how long. Ten seconds: long enough to
    -- exclude a voicemail greeting cut short and a pocket dial, short enough
    -- to keep "they said they're not interested, bye".
    when p_answered then p_duration >= 10

    -- NO answeredAt EITHER WAY, so the status has to carry it — and only a
    -- word we recognise as an answer may be combined with a duration.
    --
    -- This is the one place the deny-list above is not enough, and the
    -- reason is specific: an unanswered call's `duration` is the time it
    -- spent RINGING, and a phone rings for about twenty-five seconds before
    -- voicemail. If a status nobody has seen before were trusted with a
    -- duration, every unanswered call under a future spelling of "nobody
    -- picked up" would read as a conversation and move the lead to
    -- Contacted. That is the original bug, restored in full, by the function
    -- written to prevent it.
    when lower(coalesce(p_status, '')) in ('answered', 'forwarded', 'completed')
      then coalesce(p_duration, 0) >= 10

    else false
  end
$$;

comment on function public.sb_call_connected(text, integer, boolean) is
  'True when somebody actually picked up and stayed on the line. Reads the
   answeredAt fact first and the status vocabulary second.';

-- ---------------------------------------------------------------------------
-- 2. The words that go on the timeline
-- ---------------------------------------------------------------------------
--
-- Pulled out of record_quo_call so that reclassification can produce the
-- same sentence from the same facts. Two copies of this would drift, and the
-- drift would show up as one call reading "No answer" and an identical one
-- reading "Voicemail".
create or replace function public.sb_call_phrase(
  p_connected boolean,
  p_inbound   boolean,
  p_answered  boolean,
  p_duration  integer
)
returns text
language sql
immutable
as $$
  select case
    when p_connected and p_duration is not null
      then (p_duration / 60)::text || 'm ' || (p_duration % 60)::text || 's'
    -- Picked up, length unknown. Says what is known and no more.
    when p_connected then 'Answered'
    -- Picked up by a machine. Quo stamps an answeredAt for voicemail too,
    -- so this is the short-but-answered case.
    when p_answered and p_inbound then 'Went to our voicemail'
    when p_answered then 'Voicemail'
    -- Nothing reported yet. Honest, and replaced the moment the transcript
    -- or summary arrives with a duration.
    when p_duration is null and p_answered is null
      then 'Outcome not reported yet'
    when p_inbound then 'They rang, we missed it'
    else 'No answer'
  end
$$;

-- ---------------------------------------------------------------------------
-- 3. Recording the call
-- ---------------------------------------------------------------------------
drop function if exists public.record_quo_call(
  text, text, text, text, integer, timestamptz);

create or replace function public.record_quo_call(
  p_call_id   text,
  p_phone     text,
  p_direction text,
  p_status    text,
  p_duration  integer default null,
  p_at        timestamptz default null,
  p_answered  boolean default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  who       record;
  status    text    := lower(coalesce(p_status, ''));
  inbound   boolean := lower(coalesce(p_direction, '')) in ('in', 'incoming', 'inbound');
  connected boolean := public.sb_call_connected(p_status, p_duration, p_answered);
  -- THE INVERTED GATE. Everything not named here is written down.
  --
  -- `failed` is the network refusing the call. `unknown` is Quo declining to
  -- say. `ai-handled` is a call nobody at Sky Blue had.
  --
  -- `abandoned` depends on direction, and that is not a hedge. Outbound, it
  -- means somebody pressed call and hung up before it rang — the exact
  -- button-press-as-history this feature was built to stop. Inbound, it
  -- means a caller gave up waiting, which is a lead that tried to reach you
  -- and is the most worth knowing of the lot.
  not_a_call boolean := status in ('failed', 'unknown', 'ai-handled', 'ai_handled')
                        or (status = 'abandoned' and not inbound);
  -- Prefer the payload's own answeredAt. Fall back to the status word only
  -- when the webhook did not say, so a voicemail pickup still reads as a
  -- voicemail rather than as nobody answering.
  answered_fact boolean := coalesce(p_answered,
                             case when status in ('answered', 'forwarded') then true end);
  kind_out   text;
  detail_out text;
begin
  if coalesce(btrim(p_call_id), '') = '' then
    -- No id means no dedupe, and no dedupe means Quo's retries write the
    -- same call over and over.
    return null;
  end if;

  if not_a_call then
    return null;
  end if;

  select * into who from public.sb_contact_for_phone(p_phone);

  if who.lead_id is null and who.customer_id is null then
    -- A number nobody in the CRM owns: a supplier, a wrong number, a robocall
    -- about a Google listing. contact_log is a history of the people in this
    -- database; a log of every call to anybody is a different feature.
    return null;
  end if;

  -- Four kinds, because direction and outcome are two separate facts and the
  -- timeline has to show both. "Called" on a row where the customer rang US
  -- reads as something Sky Blue did, which is the opposite of what happened.
  kind_out := case
                when connected and inbound then 'call_in'
                when connected             then 'call'
                when inbound               then 'call_missed'
                else                            'call_attempt'
              end;

  detail_out := public.sb_call_phrase(connected, inbound, answered_fact, p_duration);

  -- THE IDS ARE PASSED DOWN. record_contact_as() resolves a person through
  -- contact_identity(), which needs an id to start from and finds nothing at
  -- all when given two nulls. A webhook has a phone number, not an id, so the
  -- lookup happens above and its answer is handed on.
  return public.record_contact_as(
    null,            -- Quo placed it; no profile in this database did.
    who.lead_id,
    who.customer_id,
    kind_out,
    detail_out,
    case when inbound then 'in' else 'out' end,
    status,
    p_duration,
    p_call_id,
    connected,
    p_at
  );
exception
  when others then
    raise warning 'record_quo_call failed for % : %', p_call_id, sqlerrm;
    return null;
end;
$$;

revoke all on function public.record_quo_call(
  text, text, text, text, integer, timestamptz, boolean) from public, anon, authenticated;

comment on function public.record_quo_call(
  text, text, text, text, integer, timestamptz, boolean) is
  'Writes one row of call history from a Quo call.completed webhook, unless
   the status says no call took place. Returns the new row id, or null for a
   repeat, a non-call, or a number nobody in the CRM owns.';

-- ---------------------------------------------------------------------------
-- 4. Reclassification, and why it lives in refresh_call_detail
-- ---------------------------------------------------------------------------
--
-- REDEFINED FROM db/call-notes.sql. That file and this one both define it;
-- this one runs later and wins. Named here rather than discovered later by
-- somebody wondering why their edit to the other file did nothing.
--
-- The addition is the kind. call.completed can arrive with no duration —
-- Quo's live webhook does exactly that — so the row is written as an attempt
-- and the summary or transcript, which does carry a duration, corrects it.
-- Without this a seventeen-second conversation stays on the timeline as
-- "No answer" forever, with its own transcript sitting underneath it.
create or replace function public.refresh_call_detail(p_call_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  note      public.call_notes;
  row_now   public.contact_log;
  dur       integer;
  inbound   boolean;
  connected boolean;
  answered_fact boolean;
  kind_out   text;
  detail_out text;
  hit        integer;
begin
  select * into note from public.call_notes where provider_call_id = p_call_id;
  if not found then
    return false;
  end if;

  select * into row_now from public.contact_log
   where provider_call_id = p_call_id;
  if not found then
    -- The summary beat call.completed here. The notes are kept and this
    -- returns false so the caller can say so; record_quo_call_with_notes
    -- calls back once the row exists.
    return false;
  end if;

  -- The duration already on the row is the authority: it came from
  -- call.completed, which is the event that knows how long the call ran. The
  -- transcript's own duration is the fallback for a row written before that
  -- number existed — which, on this account, is every row.
  dur     := coalesce(row_now.duration_seconds, note.duration_seconds);
  inbound := coalesce(row_now.direction, 'out') = 'in';

  -- p_answered is null here on purpose: by now there is a duration, and a
  -- duration is better evidence than the answeredAt guess that produced the
  -- original classification.
  connected := public.sb_call_connected(row_now.outcome, dur, null);

  -- The same fallback record_quo_call used, so a reclassified row keeps
  -- saying "Voicemail" rather than drifting to "No answer".
  answered_fact := case
                     when lower(coalesce(row_now.outcome, '')) in ('answered', 'forwarded')
                       then true
                   end;

  kind_out := case
                when row_now.kind in ('call', 'call_attempt')
                  then case when connected then 'call' else 'call_attempt' end
                when row_now.kind in ('call_in', 'call_missed')
                  then case when connected then 'call_in' else 'call_missed' end
                -- An email, a text, a note. Not ours to reclassify.
                else row_now.kind
              end;

  detail_out := case
              when connected
                then public.sb_call_detail(dur, note.summary, note.next_steps)
              -- Not a conversation, so the duration does not lead — the
              -- phrase does, and anything the summary said follows it.
              else nullif(
                     concat_ws(
                       ' · ',
                       public.sb_call_phrase(false, inbound, answered_fact, dur),
                       public.sb_call_detail(null, note.summary, note.next_steps)
                     ), '')
            end;

  update public.contact_log cl
     set duration_seconds = dur,
         kind             = kind_out,
         detail           = coalesce(detail_out, cl.detail)
   where cl.provider_call_id = p_call_id;

  get diagnostics hit = row_count;

  -- A call that turned out to BE a conversation moves a new lead along, the
  -- same as one that was known to be a conversation when it was written.
  -- Without this, every call on this account would leave its lead on New,
  -- because no duration arrives in time to say otherwise.
  if connected and row_now.lead_id is not null then
    update public.leads
       set status = case when status = 'new' then 'contacted' else status end
     where id = row_now.lead_id;
  end if;

  return hit > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The wrapper the webhook calls
-- ---------------------------------------------------------------------------
drop function if exists public.record_quo_call_with_notes(
  text, text, text, text, integer, timestamptz);

create or replace function public.record_quo_call_with_notes(
  p_call_id   text,
  p_phone     text,
  p_direction text,
  p_status    text,
  p_duration  integer default null,
  p_at        timestamptz default null,
  p_answered  boolean default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id bigint;
begin
  new_id := public.record_quo_call(
    p_call_id, p_phone, p_direction, p_status, p_duration, p_at, p_answered);

  -- Only when a row was actually written. A null means a repeat, a non-call,
  -- or a number nobody owns, and in all three there is nothing to decorate.
  if new_id is not null then
    perform public.refresh_call_detail(p_call_id);
  end if;

  return new_id;
end;
$$;

revoke all on function public.record_quo_call_with_notes(
  text, text, text, text, integer, timestamptz, boolean) from public, anon, authenticated;
