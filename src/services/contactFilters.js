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
