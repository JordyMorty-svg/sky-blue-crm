/*
 * Which timeline rows belong on a page that is already showing something.
 *
 * SEPARATE FROM contactService.js FOR ONE REASON, the same one that split
 * src/services/names.js out: this is pure, and contactService opens a
 * Supabase client at import time. A test that wants to check the filter
 * should not need a database, and under plain Node it cannot have one —
 * contactService imports "../supabaseClient" with no extension, which Vite
 * resolves and Node's ESM resolver does not.
 *
 * contactService re-exports these, so the screens keep importing from the
 * one place they always have.
 *
 * ---------------------------------------------------------------------------
 * TWO FILTERS, TWO DIFFERENT REASONS
 * ---------------------------------------------------------------------------
 *
 * contact_timeline() returns three sources stitched into one order:
 *
 *   source "contact" — calls, texts, emails, notes, opt-outs. Things that
 *                      were SAID to this person, by either side.
 *   source "lead"    — status moves. New → Contacted, Contacted → Booked.
 *   source "job"     — booked, moved, completed, paid, plan changed.
 *
 * The communication page wants the first of those and nothing else. The
 * history page wants all three. Both filters below exist so that neither
 * page has to know what a "source" is.
 */

/* --- 1. the lifecycle, on a page that is about the conversation ----------- */

/*
 * WHY THIS SPLIT EXISTS. The communication tab's timeline and the full
 * history page were printing the same list. Open a customer with one phone
 * call and you got: added as a lead, texted, called, New → Contacted,
 * Contacted → Booked, job booked, Booked → Scheduled, plan changed. Seven
 * rows of bookkeeping around the one row that said what was actually said
 * to them — on the page you opened BECAUSE you are about to talk to them.
 *
 * Worse than noise, it was the same noise twice: the Actions menu already
 * has History, and that page is the one whose job is the whole story in one
 * order. Two screens showing an identical list teaches people that one of
 * them is redundant, and they are then never sure which.
 *
 * So the communication page keeps what was said, and links to the other for
 * the rest. The rows are not deleted, not hidden behind a toggle, and not
 * unreachable — they are one press away on the page that is about them.
 *
 * NOT APPLIED ON ContactHistory.jsx, which is that other page.
 * verify/contact-texts.mjs fails if this ever reaches it.
 */
export function isContactEvent(row) {
  return row?.source === "contact";
}

/* --- 2. texts, on a page that is already showing the thread --------------- */

/*
 * On LeadComms and CustomerComms the TextThread and this timeline sit on the
 * same screen, so every text would render twice a few inches apart and the
 * calls — the thing the thread CANNOT show — would get pushed off the bottom
 * by a chatty customer.
 *
 * Folded behind a toggle rather than dropped, because the thread is capped
 * at the last 50 messages and this is not: an old conversation only exists
 * here.
 */

// 'text' is one we sent, 'text_in' is one they sent. Both are in the thread.
const TEXT_KINDS = new Set(["text", "text_in"]);

export function isTextEvent(row) {
  return TEXT_KINDS.has(row?.kind);
}

/**
 * Split a timeline into what the communication page shows, what it folds
 * away, and what it hands to the history page.
 *
 * Returns:
 *   spoken      — contact rows that are not texts. The default list.
 *   conversation— every contact row, texts included, still in order. What
 *                 the "Show N texts" toggle swaps in.
 *   textCount   — how many texts were folded away.
 *   elsewhere   — how many lifecycle rows went to the history page.
 *
 * BOTH LISTS ARE BUILT FROM THE SAME PASS over the original array rather
 * than by concatenating two halves, which is what keeps the toggled-open
 * list in time order. Merging `spoken` and `texts` afterwards would put
 * every text after every call, and a timeline out of order is worse than a
 * timeline with things missing — the second is visibly incomplete and the
 * first is quietly wrong.
 *
 * THE COUNTS ARE THE POINT of returning more than one list. A screen that
 * silently drops rows is one nobody trusts; "3 texts" and a link to the
 * rest is a screen that is tidying on your behalf and saying so.
 */
/* --- 3. what the call bar says ------------------------------------------- */

// Reaching out is something WE did. Four of these are ours and three are
// theirs, and the split is by kind because contact_timeline() does not
// return the direction column — see the note in db/orphan-calls.sql about
// what the timeline's fixed return type costs to change.
//
// `note` is not here: writing something down about somebody is not contacting
// them. Neither is `opt_out`, which is them leaving.
const OUTREACH_KINDS = new Set(["call", "call_attempt", "text", "email", "auto_email"]);

/**
 * When we last reached out to this person, and how many times, counted from
 * the timeline rather than read off their row.
 *
 * WHY NOT THE COLUMNS. leads and customers both carry last_contacted_at and
 * contact_attempts, and record_contact_as() bumps whichever row existed WHEN
 * THE CALL HAPPENED. Two cases break that, and both are ordinary:
 *
 *   Valerie was called while she was a lead and booked an hour later. The
 *   lead row has the call; the customer row created afterwards starts at
 *   zero. Her customer page said "Nobody has reached out yet" directly above
 *   a call from the same afternoon.
 *
 *   A call that arrived before she was in the CRM at all has no row to bump
 *   — db/orphan-calls.sql writes it against the phone. The column cannot
 *   ever learn about it.
 *
 * The timeline already stitches a person's leads and customers together by
 * id and by phone, which is exactly the thing the columns cannot do. So the
 * bar counts what is on screen. It is also self-healing: no backfill, and
 * every historic record is right the first time it is opened.
 *
 * Returns null when the timeline has nothing to say, so a caller can fall
 * back to the row's own columns while the fetch is still in flight rather
 * than flashing "nobody has reached out" at somebody who has been rung four
 * times.
 */
export function outreachFrom(rows = []) {
  let attempts = 0;
  let lastAt = null;

  for (const row of rows) {
    if (!isContactEvent(row) || !OUTREACH_KINDS.has(row?.kind)) continue;
    attempts++;
    // MAX, not "the last one in the array". The timeline is sorted ascending
    // and relying on that here would make this quietly wrong the day
    // somebody reverses the list for display.
    if (!lastAt || String(row.at) > String(lastAt)) lastAt = row.at;
  }

  return attempts === 0 ? null : { lastContactedAt: lastAt, attempts };
}

export function partitionTimeline(rows = []) {
  const spoken = [];
  const conversation = [];
  let textCount = 0;
  let elsewhere = 0;

  for (const row of rows) {
    if (!isContactEvent(row)) {
      elsewhere++;
      continue;
    }
    conversation.push(row);
    if (isTextEvent(row)) textCount++;
    else spoken.push(row);
  }

  return { spoken, conversation, textCount, elsewhere };
}
