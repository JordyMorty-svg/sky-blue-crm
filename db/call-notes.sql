-- Sky Blue CRM — what was actually said on the call
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- db/call-tracking.sql put real calls on the timeline: who, which way, how
-- long, and whether anybody picked up. This adds what was talked about.
--
-- Quo's AI writes a summary of every recorded call and publishes it on
-- `call.summary.completed`, with the text INLINE — no second request, no
-- polling. The transcript arrives the same way on
-- `call.transcript.completed`. Both carry `callId`, which is the same id
-- `call.completed` sends and which contact_log already stores as
-- provider_call_id, so a summary lands on the call row that exists.
--
-- TWO GATES, BOTH OUTSIDE THIS FILE:
--
--   * the Quo Business or Scale plan (Sky Blue is on Business)
--   * "Transcribe and summarize calls", which is PER PHONE NUMBER:
--     Settings -> Phone numbers -> the number -> toggle it on
--
-- Until that toggle is on, Quo sends nothing and everything here sits idle.
-- Nothing breaks; the timeline just shows durations without summaries.
--
-- A NOTE ON WHAT THIS MEANS. Oregon is one-party consent for telephone
-- calls, so recording Sky Blue's own calls is lawful on that basis. Several
-- neighbouring states are not — Washington and California require every
-- party to consent, and Corvallis is ninety minutes from the Washington
-- border. Quo can play a recording announcement at the start of a call.
-- That is a decision for Jordan and Hayden, not for this file; it is noted
-- here because this is the file somebody will read when they wonder where
-- the recordings came from.

-- ---------------------------------------------------------------------------
-- 0. What has to be there first
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.record_quo_call(text,text,text,text,integer,timestamptz)') is null then
    raise exception 'Run db/call-tracking.sql before this file.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The notes themselves
-- ---------------------------------------------------------------------------

-- A TABLE OF ITS OWN, keyed on Quo's call id rather than columns bolted
-- onto contact_log. Three reasons, and the first is the one that decides it.
--
--   ORDERING. Webhook delivery order is not guaranteed, and the summary is
--   generated after the call ends, so `call.summary.completed` can arrive
--   before the `call.completed` that creates the contact_log row — or
--   instead of it, if the call was to a number nobody in the CRM owns.
--   Keyed on the provider's id, the note survives either way and is picked
--   up when (if) the call row appears.
--
--   SIZE. A transcript of a ten-minute call is tens of kilobytes of JSON.
--   contact_log is read in full by every timeline on every page load.
--
--   FIDELITY. Storing the whole payload means a better display later —
--   an expandable transcript, a search across what was said — without
--   having to go back to Quo for data it already sent us once.
create table if not exists public.call_notes (
  -- Quo's call id (AC…). THE KEY, because it is the only identifier both
  -- sides agree on, and because it makes a webhook retry a no-op update
  -- rather than a second row.
  provider_call_id text primary key,

  -- Quo sends these as arrays of strings — a summary is several sentences
  -- and the action items are a list. Kept as arrays rather than flattened
  -- on the way in: joining them is a display decision, and a display
  -- decision belongs in the thing displaying them.
  summary      text[],
  -- Scale-plan only. Business gets the summary and the transcript; this
  -- will be null until somebody upgrades, and null is a fine answer.
  next_steps   text[],

  -- The dialogue, verbatim, as it arrived: an array of
  -- { userId | identifier, content, start, end }. jsonb rather than a
  -- child table because nothing queries inside it yet, and guessing at the
  -- shape of a provider's payload is how you end up migrating it twice.
  dialogue     jsonb,
  duration_seconds integer,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.call_notes is
  'Quo''s AI summary and transcript for one call, keyed on the provider''s
   call id. Separate from contact_log because the summary can arrive before
   the call row exists, and because a transcript is far too big to carry on
   a table every timeline reads in full.';

alter table public.call_notes enable row level security;

drop policy if exists "call_notes readable by authenticated" on public.call_notes;
create policy "call_notes readable by authenticated"
  on public.call_notes for select to authenticated using (true);

-- No insert or update policy. Writes go through the security-definer
-- functions below, which the webhook reaches as the service role — the same
-- append-only shape as contact_log and lead_events.

-- ---------------------------------------------------------------------------
-- 2. What the timeline shows
-- ---------------------------------------------------------------------------

-- The line under "Called" on somebody's history.
--
-- WRITTEN INTO contact_log.detail RATHER THAN RETURNED BY A NEW COLUMN, and
-- that is a deliberate trade worth stating.
--
-- contact_timeline() has a fixed return type, so adding a column to it means
-- `drop function` and re-declaring its whole body — in this file, where it
-- would then be a second copy of a function db/contact-history.sql also
-- defines. Whichever file was run last would win, silently.
--
-- detail is already on the timeline, already rendered under the event, and
-- already the field that says "4m 12s". Putting the summary there costs one
-- UPDATE and no new surface at all. call_notes above remains the record of
-- truth; this is a rendering of it, refreshed whenever either half arrives.
create or replace function public.sb_call_detail(
  p_duration integer,
  p_summary  text[],
  p_next     text[]
)
returns text
language sql
immutable
as $$
  select nullif(
    concat_ws(
      ' · ',
      -- "4m 12s" stays FIRST. It is the fact somebody scans for, and a
      -- paragraph of summary in front of it would bury the one number that
      -- tells you whether this was a conversation or a voicemail.
      case
        when p_duration is not null
          then (p_duration / 60)::text || 'm ' || (p_duration % 60)::text || 's'
      end,
      nullif(array_to_string(coalesce(p_summary, '{}'), ' '), ''),
      case
        when coalesce(array_length(p_next, 1), 0) > 0
          then 'Next: ' || array_to_string(p_next, ' ')
      end
    ),
    ''
  )
$$;

-- Put the current notes onto the call row, if there is one yet.
--
-- Called from BOTH directions — when the notes arrive and when the call row
-- is created — because either can happen first. Returns true when a row was
-- actually updated, which is what lets the webhook log tell "nothing to
-- update yet" apart from "updated".
create or replace function public.refresh_call_detail(p_call_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  note public.call_notes;
  hit  integer;
begin
  select * into note from public.call_notes where provider_call_id = p_call_id;
  if not found then
    return false;
  end if;

  update public.contact_log cl
     set detail = public.sb_call_detail(
                    -- The duration already on the row is the authority: it
                    -- came from call.completed, which is the event that
                    -- knows how long the call ran. The transcript's own
                    -- duration is a fallback for a row created before that
                    -- event arrived.
                    coalesce(cl.duration_seconds, note.duration_seconds),
                    note.summary,
                    note.next_steps
                  )
   where cl.provider_call_id = p_call_id;

  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The two events
-- ---------------------------------------------------------------------------

-- `call.summary.completed`.
--
-- Returns true when the summary reached a call on somebody's timeline,
-- false when it was kept but has nowhere to show yet — a call to a number
-- with no lead and no customer, or a summary that overtook its own
-- call.completed. Both are ordinary; the difference is the whole content of
-- the webhook's log line.
create or replace function public.record_call_summary(
  p_call_id text,
  p_summary text[],
  p_next    text[] default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(p_call_id), '') = '' then
    return false;
  end if;

  -- Nothing to record. Quo sends processingStatus 'failed' and 'absent'
  -- with null content, and writing an empty row for those would make a
  -- call look summarised when it was not.
  if coalesce(array_length(p_summary, 1), 0) = 0
     and coalesce(array_length(p_next, 1), 0) = 0 then
    return false;
  end if;

  insert into public.call_notes (provider_call_id, summary, next_steps)
  values (p_call_id, p_summary, p_next)
  on conflict (provider_call_id) do update
    -- COALESCE, not overwrite. The summary and the transcript arrive as two
    -- separate events in no guaranteed order, and a plain assignment here
    -- would blank whichever one landed first.
    set summary    = coalesce(excluded.summary, call_notes.summary),
        next_steps = coalesce(excluded.next_steps, call_notes.next_steps),
        updated_at = now();

  return public.refresh_call_detail(p_call_id);
exception
  when others then
    -- Never throws: the caller is a webhook that must answer 200 or Quo
    -- retries, and losing one summary is smaller than a retry storm.
    raise warning 'record_call_summary failed for % : %', p_call_id, sqlerrm;
    return false;
end;
$$;

-- `call.transcript.completed`.
create or replace function public.record_call_transcript(
  p_call_id  text,
  p_dialogue jsonb,
  p_duration integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(p_call_id), '') = '' then
    return false;
  end if;

  -- An empty dialogue is a transcript of silence. Quo sends one for a call
  -- that was recorded but had nothing in it, and storing it would claim we
  -- have a transcript when we have nothing to show.
  if p_dialogue is null or jsonb_array_length(coalesce(p_dialogue, '[]'::jsonb)) = 0 then
    return false;
  end if;

  insert into public.call_notes (provider_call_id, dialogue, duration_seconds)
  values (p_call_id, p_dialogue, p_duration)
  on conflict (provider_call_id) do update
    set dialogue         = coalesce(excluded.dialogue, call_notes.dialogue),
        duration_seconds = coalesce(excluded.duration_seconds, call_notes.duration_seconds),
        updated_at       = now();

  -- Refreshed even though a transcript changes no words on the timeline:
  -- it can carry the DURATION for a call row created before call.completed
  -- arrived, and sb_call_detail reads that.
  return public.refresh_call_detail(p_call_id);
exception
  when others then
    raise warning 'record_call_transcript failed for % : %', p_call_id, sqlerrm;
    return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The other direction: a call that arrives after its summary
-- ---------------------------------------------------------------------------

-- record_quo_call() writes contact_log.detail itself — "4m 12s", "No
-- answer", "Voicemail". When the summary got here first, that write would
-- throw the summary away.
--
-- So it is wrapped: do what it always did, then put the notes back on top
-- if there are any. Wrapped rather than edited, because db/call-tracking.sql
-- owns that function and a second definition of it here is exactly the
-- "whichever file ran last wins" trap this file avoids elsewhere.
create or replace function public.record_quo_call_with_notes(
  p_call_id   text,
  p_phone     text,
  p_direction text,
  p_status    text,
  p_duration  integer default null,
  p_at        timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id bigint;
begin
  new_id := public.record_quo_call(p_call_id, p_phone, p_direction, p_status, p_duration, p_at);

  -- Only when a row was actually written. A null means a repeat, an
  -- outcome we do not log, or a number nobody owns — and in all three
  -- there is nothing to decorate.
  if new_id is not null then
    perform public.refresh_call_detail(p_call_id);
  end if;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reading one back
-- ---------------------------------------------------------------------------

-- Everything Quo said about the calls with one person, for a transcript
-- view that does not exist yet. Written now because the data is being
-- stored now, and a table nothing can read is a table nobody trusts.
create or replace function public.call_notes_for(
  p_lead_id     uuid default null,
  p_customer_id uuid default null
)
returns table (
  provider_call_id text,
  at               timestamptz,
  direction        text,
  duration_seconds integer,
  summary          text[],
  next_steps       text[],
  dialogue         jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ident record;
begin
  select * into ident from public.contact_identity(p_lead_id, p_customer_id);

  return query
  select cl.provider_call_id,
         cl.created_at,
         cl.direction,
         coalesce(cl.duration_seconds, n.duration_seconds),
         n.summary,
         n.next_steps,
         n.dialogue
    from public.contact_log cl
    join public.call_notes n on n.provider_call_id = cl.provider_call_id
   where cl.provider_call_id is not null
     and (cl.lead_id = any(ident.lead_ids) or cl.customer_id = any(ident.customer_ids))
   order by cl.created_at desc;
end;
$$;

grant execute on function public.call_notes_for(uuid, uuid) to authenticated;

-- Not granted to authenticated: these write, and the browser has no
-- business claiming a call was summarised.
revoke all on function public.record_call_summary(text, text[], text[])
  from public, anon, authenticated;
revoke all on function public.record_call_transcript(text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.record_quo_call_with_notes(text, text, text, text, integer, timestamptz)
  from public, anon, authenticated;
