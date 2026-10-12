/*
 * Which timeline rows are already on screen somewhere else.
 *
 * SEPARATE FROM contactService.js FOR ONE REASON, the same one that split
 * src/services/names.js out: this is pure, and contactService opens a
 * Supabase client at import time. A test that wants to check the filter
 * should not need a database, and under plain Node it cannot have one —
 * contactService imports "../supabaseClient" with no extension, which Vite
 * resolves and Node's ESM resolver does not.
 *
 * contactService re-exports both of these, so the screens keep importing
 * from the one place they always have.
 */

/*
 * Texts, on a page that is already showing the thread.
 *
 * WHY THESE ARE HIDDEN AND NOT REMOVED. On LeadComms and CustomerComms the
 * TextThread and this timeline sit on the same screen, so every text is
 * rendered twice a few inches apart and the calls, emails, status moves and
 * job milestones — the things the thread CANNOT show — get pushed off the
 * bottom by a chatty customer.
 *
 * But the rows stay in the database and stay in this list, because:
 *
 *   * the thread is capped at the last 50 messages and the timeline is not,
 *     so an old conversation only exists here
 *   * contact_timeline() is the only place the whole relationship appears
 *     in one order, and a timeline with texts missing is a timeline with
 *     holes in it the moment somebody needs to reconstruct what happened
 *
 * NOT APPLIED ON ContactHistory.jsx. That page is "everything that ever
 * happened with one person" and has no thread beside it; filtering there
 * would silently delete half its content. verify/contact-texts.mjs fails if
 * this ever reaches it.
 */

// 'text' is one we sent, 'text_in' is one they sent. Both are in the thread.
const TEXT_KINDS = new Set(["text", "text_in"]);

export function isTextEvent(row) {
  return TEXT_KINDS.has(row?.kind);
}

/**
 * Split a timeline into the part worth showing beside a thread, and the
 * texts the thread is already showing.
 *
 * Returns both, rather than just the filtered list, because the screen has
 * to be able to say HOW MANY it is hiding. A timeline that quietly drops
 * rows is one nobody trusts; "14 texts" is a timeline that is keeping
 * something tidy.
 */
export function partitionTexts(rows = []) {
  const texts = [];
  const rest = [];
  for (const row of rows) (isTextEvent(row) ? texts : rest).push(row);
  return { rest, texts, textCount: texts.length };
}

