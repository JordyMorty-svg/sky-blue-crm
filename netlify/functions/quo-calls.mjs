// netlify/functions/quo-calls.mjs
//
// Where Quo tells us a call finished. Subscribe this URL to `call.completed`
// in the Quo console, with the same signing secret as the SMS webhook.
//
// WHAT IT REPLACES. The Call button used to log the call itself, on click,
// before anything had happened. On a laptop — where a tel: link opens
// nothing — pressing it logged a call. On a phone, pressing it and then
// pressing cancel logged a call. Ringing out logged a call. contact_attempts
// was counting button presses, and "3 attempts, no answer" and "pressed a
// button three times" are not the same fact.
//
// Quo placed the call, so Quo knows. This is the endpoint that asks it to
// say so, and db/call-tracking.sql decides what each answer means.
//
// IT ALSO PICKS UP CALLS THE CRM NEVER SAW. Hayden ringing a customer back
// from the Quo app on the way to a job has never been in this database. From
// here on it is, with its real duration, on the right person's history —
// which is the same gap sms-inbound.mjs closed for texts typed in the app.
//
// Required Netlify environment variables — ALL OF THEM ALREADY SET, if texts
// are working. This endpoint introduces no new ones:
//   QUO_WEBHOOK_SECRET and/or QUO_CALL_WEBHOOK_SECRET — either, or both. Both
//                                 are tried against every request, so the one
//                                 Quo signed with wins and the other costs a
//                                 hash. See quoSecrets().
//   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY),
//   VITE_SUPABASE_URL (or SUPABASE_URL) — to write the row.
//
// Optional:
//   QUO_FROM — the business number. Only used as a fallback for working out
//              which participant is the customer; the payload normally says.

import { rpc } from "../lib/db.mjs";
import { quoSecrets, signatureProblem, webhookHeaders } from "../lib/webhooks.mjs";
import { toE164 } from "../lib/sms.mjs";

/**
 * Pull a call out of a Quo webhook.
 *
 * Written as defensively as readEvent() in sms-inbound.mjs, and for the same
 * reason plus one. The same reason: this payload's shape belongs to somebody
 * else, and it changed once already when OpenPhone became Quo. The extra
 * one: the call events put the body under `data.resource` where the message
 * events put it under `data.object`, so the two shapes are already live at
 * the same time and a parser that knows only one of them is already wrong.
 */
function hasKey(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * The same object with every phone number cut down to its last four digits.
 *
 * Printed into a Netlify log, which is kept, searchable, and visible to
 * anyone with access to the account. The field names and the shape are what
 * is worth having there; the customer's number is not, and the rest of this
 * codebase has always logged `who: '3646'` for the same reason.
 *
 * Seven digits is the shortest thing that could be a phone number and the
 * longest thing that could not be anything else — an id like `AC96e3f2…` has
 * letters in it and is left alone.
 */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  if (typeof value === "string" && /^\+?[\d\s()-]{7,}$/.test(value)) {
    return `…${value.replace(/\D/g, "").slice(-4)}`;
  }
  return value;
}

export function readCall(payload) {
  const type = payload?.type || payload?.event || null;
  const data = payload?.data || payload || {};

  // `resource` on the call events, `object` on the message events, and the
  // bare body on an older shape. All three accepted rather than one.
  const obj = data.resource || data.object || data || {};
  const ctx = data.context || obj.context || {};

  const id = obj.id || payload?.id || null;

  // "incoming" / "outgoing" on the documented shape, "in" / "out" on the
  // older one. Normalised downstream by record_quo_call(), which accepts
  // every spelling of inbound it has been shown.
  const direction = obj.direction || null;

  const status = obj.status || null;

  // DID SOMEBODY PICK UP. The one fact that survives Quo renaming a status.
  //
  // `completed` is what Quo sends when a call ends, whether anybody answered
  // it or not — the live webhook, the whole time, has been sending
  // `status: 'completed', duration: null` for calls that were real
  // seventeen-second conversations. There is nothing in the status to read.
  //
  // THREE STATES, not two. A missing answeredAt FIELD is "the payload did
  // not say"; a present-but-null one is Quo saying nobody picked up. Folding
  // those together would turn every older payload shape into "not answered"
  // and bury the real calls in it.
  const answered = hasKey(obj, "answeredAt") ? Boolean(obj.answeredAt) : null;

  // Seconds. Number() rather than trusting it: a string "55" compares
  // false against every numeric threshold and would silently turn a real
  // conversation into "no answer".
  const rawDuration = obj.duration ?? obj.durationSeconds ?? null;
  let duration =
    rawDuration == null || rawDuration === "" ? null : Number(rawDuration);

  // DERIVED WHEN QUO HAS NOT WORKED IT OUT YET, which on this account is
  // every call: call.completed fires the moment the call ends and carries a
  // null duration, while the same call read back from the API a minute later
  // reports 17s. The two timestamps are both in the payload, and the gap
  // between them is the call.
  if (!Number.isFinite(duration) && obj.answeredAt && obj.completedAt) {
    const span = (Date.parse(obj.completedAt) - Date.parse(obj.answeredAt)) / 1000;
    if (Number.isFinite(span) && span >= 0) duration = span;
  }

  // ROUNDED. The database column is an integer and Quo sends fractions —
  // a transcript arrived with `duration: 6.55675` and Postgres rejected the
  // whole write with `invalid input syntax for type integer`, which took the
  // summary down with it.
  if (Number.isFinite(duration)) duration = Math.round(duration);

  // WHEN IT HAPPENED, not when this request arrived.
  //
  // Quo retries anything that is not a 2xx, so a webhook delivered twenty
  // minutes late must not put the call twenty minutes after it happened.
  // completedAt first because that is the end of the call, which is what a
  // timeline entry is about.
  const at =
    obj.completedAt || obj.answeredAt || obj.createdAt || obj.updatedAt || null;

  return {
    type,
    id,
    direction,
    status,
    duration: Number.isFinite(duration) ? duration : null,
    answered,
    at,
    phone: customerNumber(obj, ctx),
    raw: obj,
  };
}

/**
 * Which of the two numbers on this call is the customer.
 *
 * `participants.external` is the one to trust: Quo has already separated its
 * own numbers from everybody else's, and it is right about which of its
 * numbers are its own in a way this code can only guess at.
 *
 * The fallbacks exist because that field is newer than the events
 * themselves. Deriving it from direction is correct but relies on the
 * payload naming `from` and `to`, which the documented call shape does not;
 * subtracting QUO_FROM from a flat participant list is last because it is
 * wrong the day somebody adds a second Quo number.
 */
export function customerNumber(obj, ctx = {}) {
  const external = ctx?.participants?.external;
  if (Array.isArray(external) && external[0]) return external[0];

  const incoming = /^(in|incoming|inbound)$/i.test(String(obj?.direction || ""));
  const byDirection = incoming ? obj?.from : obj?.to;
  if (byDirection) {
    return Array.isArray(byDirection) ? byDirection[0] ?? null : byDirection;
  }

  const flat = Array.isArray(obj?.participants) ? obj.participants : [];
  if (flat.length) {
    const ours = toE164(process.env.QUO_FROM);
    // Only when subtracting our own number leaves exactly one candidate. Two
    // left means a conference or a second workspace number, and picking the
    // first of those would file the call against whichever participant Quo
    // happened to list first.
    const theirs = flat.filter((p) => !ours || toE164(p) !== ours);
    if (theirs.length === 1) return theirs[0];
  }

  return null;
}

/**
 * The AI summary of a call, or its transcript.
 *
 * Both arrive on the SAME subscription as call.completed — Quo replaced its
 * four per-type webhook endpoints with one unified create, so a single
 * subscription pointed at this URL carries all three with one signing
 * secret. That is why they are handled here rather than in an endpoint of
 * their own.
 *
 * `callId`, not `id`. The resource IS the summary; the call it belongs to
 * is named separately, and reading `id` here would attach every summary to
 * nothing.
 */
export function readNotes(payload) {
  const type = payload?.type || payload?.event || null;
  const data = payload?.data || payload || {};
  const obj = data.resource || data.object || data || {};

  const asArray = (v) =>
    v == null ? null : Array.isArray(v) ? v.filter(Boolean) : [String(v)];

  return {
    type,
    callId: obj.callId || obj.call_id || null,
    // 'absent' | 'in-progress' | 'completed' | 'failed'. Anything other
    // than completed carries null content, and recording it would make a
    // call look summarised when it is not.
    status: obj.processingStatus || obj.status || null,
    summary: asArray(obj.summary),
    nextSteps: asArray(obj.nextSteps ?? obj.next_steps),
    dialogue: Array.isArray(obj.dialogue) ? obj.dialogue : null,
    // ROUNDED, because call_notes.duration_seconds is an integer and Quo
    // sends fractional seconds on the transcript event. `6.55675` took down
    // the entire write with "invalid input syntax for type integer".
    duration:
      obj.duration == null || obj.duration === ""
        ? null
        : Number.isFinite(Number(obj.duration))
          ? Math.round(Number(obj.duration))
          : null,
  };
}

export function isSummary(type) {
  return /^call\.summary\.completed$/.test(String(type || "").toLowerCase());
}

export function isTranscript(type) {
  return /^call\.transcript\.completed$/.test(String(type || "").toLowerCase());
}

/**
 * Is this the event we subscribed to?
 *
 * `call.completed` is the only one with a terminal status and a duration on
 * it, which is to say the only one that can answer "did this call actually
 * happen". `call.ringing` and `call.answered` both describe a call still in
 * progress, and a row written from either would be the old optimistic
 * logging with extra steps.
 *
 * Matched loosely on purpose, and NOT on `.recording`/`.summary`/
 * `.transcript`/`.voicemail`, which are their own completions of their own
 * things and carry no call status at all.
 */
export function isCallCompleted(evt) {
  const type = String(evt.type || "").toLowerCase();
  if (type) {
    return (
      /^call\.completed$/.test(type) ||
      (/call/.test(type) &&
        /completed/.test(type) &&
        !/recording|summary|transcript|voicemail/.test(type))
    );
  }
  // No type at all. Fall back to the shape: a terminal status and an id is
  // what a completed call looks like, and nothing else Quo sends has both.
  return Boolean(evt.id && evt.status);
}

/**
 * Everything a call event means, with the signature already checked.
 *
 * EXPORTED, and that is the point of the split. Quo replaced its four
 * per-type webhook endpoints with one unified subscription, so the natural
 * shape now is ONE webhook in Quo carrying call events and message events
 * together — and a single subscription can only have one URL.
 *
 * Sky Blue's was pointed at /api/sms-inbound with `call.completed` ticked.
 * That endpoint read the call, found no `to` and no text, and dropped it:
 * 200, no row, no log, nothing to see. Calls had been disappearing into the
 * texts endpoint since the day it was set up.
 *
 * So rather than make somebody split one webhook into two and keep two
 * secrets in step, sms-inbound.mjs imports this and hands over anything
 * whose type begins with "call.". Both URLs now do the right thing with
 * either kind of event, and a webhook pointed at the wrong one of them
 * still works.
 */
export async function handleCallEvent(payload) {
  const evt = readCall(payload);

  // ONE LINE PER INVOCATION, WHATEVER HAPPENS, AND IT IS NOT CHATTY NOISE.
  //
  // The first version logged only the calls it recorded, with a comment
  // arguing that a line for every ignored event would bury the ones that
  // matter. That was wrong, and it cost an evening. Jordan rang his own
  // number from Quo, nothing appeared on the timeline, and the Netlify log
  // was completely empty — which is identical to Quo never calling us at
  // all. Three of the four ways this endpoint declines to record something
  // returned silently, so "it didn't work" carried no information about
  // WHICH thing didn't work.
  //
  // Sky Blue makes a few dozen calls a week. The entire argument for
  // staying quiet was a volume problem that does not exist.
  const seen = {
    type: evt.type,
    id: evt.id,
    direction: evt.direction,
    status: evt.status,
    duration: evt.duration,
    answered: evt.answered,
    // Last four only, the way the rest of this codebase logs numbers.
    who: evt.phone ? String(evt.phone).slice(-4) : null,
  };

  // The summary and the transcript, before the completed-call branch.
  //
  // isCallCompleted() deliberately excludes them — they are completions of
  // a recording, not of a call, and treating one as a call would write a
  // second row for a call already on the timeline. They have their own
  // handling because they carry their own content.
  if (isSummary(evt.type) || isTranscript(evt.type)) {
    const note = readNotes(payload);
    const kind = isSummary(evt.type) ? "summary" : "transcript";

    if (!note.callId) {
      console.warn(`[quo-calls] a ${kind} with no callId`, { type: evt.type });
      return new Response(null, { status: 200 });
    }

    // Quo publishes the event for every processing state, and only
    // 'completed' carries words. The rest are progress reports.
    if (note.status && String(note.status).toLowerCase() !== "completed") {
      console.log(`[quo-calls] ${kind} not ready`, {
        callId: note.callId,
        status: note.status,
      });
      return new Response(null, { status: 200 });
    }

    try {
      const attached = isSummary(evt.type)
        ? await rpc("record_call_summary", {
            p_call_id: note.callId,
            p_summary: note.summary,
            p_next: note.nextSteps,
          })
        : await rpc("record_call_transcript", {
            p_call_id: note.callId,
            p_dialogue: note.dialogue,
            p_duration: note.duration,
          });

      console.log(
        attached
          ? `[quo-calls] ${kind} attached to the call`
          : `[quo-calls] ${kind} kept, but no call row to show it on yet`,
        {
          callId: note.callId,
          lines: note.summary?.length ?? note.dialogue?.length ?? 0,
        }
      );
    } catch (err) {
      // Most likely db/call-notes.sql has not been run. Named rather than
      // buried, because that is a one-line fix and otherwise a mystery.
      console.error(`[quo-calls] could not record a ${kind}`, err);
    }

    return new Response(null, { status: 200 });
  }

  if (!isCallCompleted(evt)) {
    // A ringing or answered event for a call still in progress, or a
    // recording/transcript/summary completion. Ordinary — one subscription
    // delivers several event types — but worth naming, because "the wrong
    // webhook type is subscribed" looks exactly like this and looked like
    // nothing at all before.
    console.log("[quo-calls] ignored: not a completed call", seen);
    return new Response(null, { status: 200 });
  }

  if (!evt.phone) {
    console.warn("[quo-calls] no customer number on a completed call", {
      ...seen,
      // The participants are the whole reason this can happen, so print
      // what arrived rather than making somebody guess at the shape.
      participants: payload?.data?.context?.participants ?? evt.raw?.participants ?? null,
    });
    return new Response(null, { status: 200 });
  }

  try {
    // record_quo_call_with_notes, not record_quo_call: a summary can reach
    // us BEFORE the call.completed that creates the row, and the plain
    // function would then write "4m 12s" over the top of it. The wrapper
    // does what it always did and puts the notes back on afterwards. See
    // db/call-notes.sql.
    const id = await rpc("record_quo_call_with_notes", {
      p_call_id: evt.id,
      p_phone: evt.phone,
      p_direction: evt.direction,
      p_status: evt.status,
      p_duration: evt.duration,
      p_at: evt.at,
      // The fact, not the word. db/call-outcome.sql reads this before it
      // reads the status, because the status is `completed` either way.
      p_answered: evt.answered,
    });

    if (id) {
      console.log("[quo-calls] logged", { ...seen, row: id });
    } else {
      // THE LINE THAT WAS MISSING. record_quo_call returns null for three
      // different ordinary reasons and they are not distinguishable from
      // here — but printing what we sent is enough to tell them apart by
      // eye, which is all anybody needed:
      //
      //   a repeat        — the same id already logged; Quo retries
      //   not a call      — failed, abandoned, ai-handled, unknown
      //   nobody we know  — a number with no lead and no customer
      //
      // That last one is the one worth staring at during setup: it is what
      // a test call to a number that is not on any record looks like.
      console.log(
        "[quo-calls] NOT recorded — either a repeat, an outcome we don't log, " +
          "or a number with no lead or customer in the CRM",
        seen,
        // THE WHOLE RESOURCE, on this branch only.
        //
        // This is the branch that was wrong for a month, and the reason it
        // took a month is that the log printed the six fields this code had
        // decided to care about — so a status it did not recognise looked
        // exactly like a duplicate. On the one branch where the CRM has
        // declined to write something down, print what arrived instead of a
        // summary of it.
        //
        // Numbers are masked: a Netlify log is not a place to keep a
        // customer list.
        { payload: redact(evt.raw) }
      );
    }
  } catch (err) {
    // Never 5xx at Quo. It retries, and a retry of a call that WAS in fact
    // recorded is handled by the unique index — but a retry storm is not
    // handled by anything.
    console.error("[quo-calls] could not record a call", err);
  }

}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Read as text, sign the text. Parsing first and re-serialising changes
  // the bytes and every signature fails.
  const raw = await req.text();

  // EVERY secret this deployment holds, not the first one that is set. Quo
  // issues one per subscription and either is legitimate here; see
  // quoSecrets() in netlify/lib/webhooks.mjs for why the `||` this replaced
  // made a wrong QUO_CALL_WEBHOOK_SECRET unfixable by adding one.
  const problem = signatureProblem({
    ...webhookHeaders(req),
    body: raw,
    secret: quoSecrets(),
  });

  if (problem) {
    // Named, not "bad signature". Refused, and a 403 rather than a 401:
    // there is nothing to authenticate with and nothing useful to say to
    // whoever sent this — but there is plenty useful to say to us.
    console.warn(`[quo-calls] rejected: ${problem}`);
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed but unparseable. 200 rather than 400: it is genuinely from Quo,
    // and a 4xx would have them retry something that will never parse.
    console.error("[quo-calls] signed payload was not JSON");
    return new Response(null, { status: 200 });
  }

  await handleCallEvent(payload);

  return new Response(null, { status: 200 });
};

export const config = {
  path: "/api/quo-calls",
};
