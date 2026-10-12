// What the communication page's timeline shows, and what it doesn't:
//   node verify/contact-texts.mjs
//
// TWO FILTERS, TWO REASONS, and this file guards both.
//
//   1. TEXTS are folded behind a toggle, because the TextThread sits a few
//      inches above the timeline on the same screen and every text would
//      otherwise render twice.
//
//   2. LIFECYCLE ROWS — status moves and job milestones — are dropped
//      entirely, because this timeline and ContactHistory.jsx were printing
//      an identical list and the lifecycle rows outnumbered the
//      conversation six to one on an ordinary customer.
//
// The risk this file exists for is not either filter. It is the THIRD PAGE.
// ContactHistory.jsx is "everything that ever happened with one person" and
// has no thread beside it; either filter applied there silently deletes
// most of its content, and it would look like a page that simply had less
// on it. Nobody would file that as a bug for months.
//
// Checks marked THE POINT are the ones this file exists for.

import { readFileSync } from "node:fs";
// From contactFilters, not contactService: the latter opens a Supabase
// client at import time and imports "../supabaseClient" with no extension,
// which Vite resolves and plain Node does not. The screens import these
// from contactService, which re-exports them.
import {
  isContactEvent,
  isTextEvent,
  partitionTimeline,
} from "../src/services/contactFilters.js";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// COMMENTS COME OUT BEFORE ANY SOURCE-TEXT ASSERTION. Every check below
// that greps a file would otherwise pass on a sentence in a comment
// describing the thing it is looking for — and the comments in these files
// describe it at length. Sixth time this has mattered in this repo.
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

console.log("\n-- which rows are texts --\n");

{
  chk("THE POINT: both directions count as texts",
    isTextEvent({ kind: "text" }) && isTextEvent({ kind: "text_in" }),
    "'text' is one we sent and 'text_in' is one they sent; the thread shows " +
      "both, so hiding only one half leaves the timeline half-duplicated");

  chk("a call is not a text",
    !isTextEvent({ kind: "call" }) &&
      !isTextEvent({ kind: "call_in" }) &&
      !isTextEvent({ kind: "call_missed" }),
    "calls are the single most valuable thing on this timeline and the one " +
      "the thread cannot show at all");

  chk("...nor is an email, a note or a status change",
    !isTextEvent({ kind: "email" }) &&
      !isTextEvent({ kind: "note" }) &&
      !isTextEvent({ kind: "status" }));

  chk("a row with no kind does not throw, and is not called a text",
    !isTextEvent({}) && !isTextEvent(undefined) && !isTextEvent(null));
}

console.log("\n-- which rows are a conversation --\n");

{
  chk("THE POINT: a contact row is, whatever kind it is",
    ["call", "call_attempt", "call_in", "call_missed", "text", "text_in",
     "email", "auto_email", "note", "opt_out"]
      .every((kind) => isContactEvent({ source: "contact", kind })),
    "the split is on SOURCE, not on a list of kinds — a list would have to " +
      "be edited every time contact_log learns a new one, and the failure " +
      "mode is a channel that silently stops appearing on the page about " +
      "talking to people");

  chk("THE POINT: emails stay, calls stay",
    isContactEvent({ source: "contact", kind: "email" }) &&
      isContactEvent({ source: "contact", kind: "call" }),
    "the CRM emails the quote when the text fails, so the interesting case " +
      "is exactly the one where both are on this list");

  chk("a status move is not",
    !isContactEvent({ source: "lead", from_status: "new", to_status: "contacted" }));

  chk("nor is a job milestone",
    !isContactEvent({ source: "job", kind: "scheduled" }) &&
      !isContactEvent({ source: "job", kind: "plan" }) &&
      !isContactEvent({ source: "job", kind: "payment" }));

  chk("an unknown source is dropped from this page, not kept",
    !isContactEvent({ source: "invoice" }) &&
      !isContactEvent({}) &&
      !isContactEvent(undefined) &&
      !isContactEvent(null),
    "the opposite of the rule for kinds, and deliberately: a new KIND of " +
      "contact belongs on the conversation page, a new SOURCE is a new " +
      "class of bookkeeping and belongs on the history page until somebody " +
      "decides otherwise");
}

console.log("\n-- splitting a timeline --\n");

{
  // Valerie Krauss's actual timeline from the screenshot that prompted
  // this, in order: lead added, text, call that also moved the status,
  // status move, status move, job booked, status move, plan changed.
  const rows = [
    { source: "lead", at: 1 },
    { source: "contact", kind: "text", at: 2 },
    { source: "contact", kind: "call", at: 3 },
    { source: "lead", at: 4 },
    { source: "lead", at: 5 },
    { source: "job", kind: "scheduled", at: 6 },
    { source: "lead", at: 7 },
    { source: "job", kind: "plan", at: 8 },
  ];

  const { spoken, conversation, textCount, elsewhere } = partitionTimeline(rows);

  chk("THE POINT: one call survives a timeline of eight",
    spoken.map((r) => r.at).join(",") === "3",
    "this is the screenshot that prompted the change: seven rows of " +
      "bookkeeping around the one row saying what was said to her");

  // COUNT ONLY. The order of `conversation` is the next check's job, and
  // asserting it in both means a reordering bug reports as two failures
  // with one cause — which is how a verify run stops being read.
  chk("the texts are counted, not thrown away",
    textCount === 1 && conversation.length === 2);

  chk("THE POINT: the toggled-open list is still in time order",
    conversation.map((r) => r.at).join(",") === "2,3",
    "built in one pass over the original rather than by concatenating " +
      "spoken and texts, which would put every text after every call — a " +
      "timeline out of order is worse than one with things missing, " +
      "because the second is visibly incomplete and the first is quietly " +
      "wrong");

  chk("THE POINT: the lifecycle rows are counted so the page can link to them",
    elsewhere === 6,
    "four lead rows and two job rows; a list that quietly shrinks is one " +
      "nobody trusts, and the count is what makes 'Full history (6)' read " +
      "as a pointer rather than an apology");

  chk("nothing is unaccounted for",
    conversation.length + elsewhere === rows.length &&
      spoken.length + textCount === conversation.length);

  chk("an empty timeline is fine",
    partitionTimeline([]).textCount === 0 &&
      partitionTimeline().elsewhere === 0 &&
      partitionTimeline().spoken.length === 0,
    "called on every render, including the first one before the fetch lands");
}

console.log("\n-- the two pages that filter --\n");

for (const page of [
  "src/pages/leads/LeadComms.jsx",
  "src/pages/customers/CustomerComms.jsx",
]) {
  const src = strip(readFileSync(page, "utf8"));
  const name = page.split("/").pop();

  chk(`${name} renders the filtered list, not the raw one`,
    /shownRows\.map\(/.test(src) && !/\brows\.map\(/.test(src),
    "mapping `rows` straight back would leave the filter computed and unused, " +
      "which looks exactly like a working filter in a diff");

  chk(`${name} toggles between spoken and conversation, not rows`,
    /showTexts \? conversation : spoken/.test(src),
    "`showTexts ? rows : spoken` is the mutant this catches — pressing " +
      "'Show texts' would bring the whole lifecycle back with them, which " +
      "is the exact thing being removed");

  chk(`${name} starts with texts hidden`,
    /useState\(false\)/.test(src) && /showTexts/.test(src));

  chk(`${name} can still show them`,
    /setShowTexts\(\(v\) => !v\)/.test(src));

  chk(`${name} says how many texts are hidden`,
    /\{textCount\}\s*text/.test(src),
    "a count, not just the word 'texts' — the number is what makes it read " +
      "as tidying rather than as missing data");

  // THE POINT OF THE WHOLE CHANGE IS THAT THE ROWS ARE STILL REACHABLE.
  // Dropping them with no way back is not tidying, it is losing them, and
  // the difference is one link.
  chk(`${name} links to the full history`,
    /comms__fulllink/.test(src) && /Full history/.test(src) && /\{elsewhere\}/.test(src),
    "with the count — 'Full history' alone does not tell you whether " +
      "pressing it is worth the tap");

  chk(`${name} only offers the link when there is something behind it`,
    /elsewhere > 0 && \(/.test(src),
    "a link to a page that shows nothing new is the control that teaches " +
      "people to stop pressing links");

  chk(`${name} sends Back to this tab`,
    /from: `\/(leads|customers)\/\$\{id\}\/communication`/.test(src),
    "ContactHistory prefers state.from over its own guess, and its guess " +
      "is the record's first tab — without this, Back from the full " +
      "history lands somewhere the user never was");

  // THE EMPTY STATE THAT WOULD LOOK LIKE DATA LOSS, now with a second way
  // to hit it: a customer added by hand and booked the same afternoon has
  // a full timeline and not one conversation on it.
  chk(`${name} explains an empty list that is empty only because of a filter`,
    /Only texts so far/.test(src) && /No calls or emails yet/.test(src),
    "'Nothing recorded yet' above a full thread, or beside a 'Full history " +
      "(8)' link, reads as data loss");

  chk(`${name} does not say "History" as this section's heading`,
    !/comms__historytitle">History</.test(src),
    "that is the name of the whole page in the Actions menu, and two " +
      "things with the same name showing different lists is how somebody " +
      "concludes one of them is broken");
}

console.log("\n-- the page that must NOT filter --\n");

{
  const src = strip(readFileSync("src/pages/history/ContactHistory.jsx", "utf8"));

  chk("THE POINT: ContactHistory filters nothing out",
    !/partitionTimeline|isTextEvent|isContactEvent|showTexts|shownRows/.test(src),
    "it is reached at /history/lead/:id as 'everything that ever happened " +
      "with one person' and has no thread beside it — filtering here is " +
      "most of the page gone, and it would look like a page that just has " +
      "less on it. It is also now the ONLY place the lifecycle appears " +
      "beside the conversation, so this check matters more than it did.");

  chk("...and it still has no text thread of its own",
    !/TextThread/.test(src),
    "the day it grows one, the text filter belongs there too — and this " +
      "check is what will say so");
}

console.log(bad === 0
  ? "\nall ok — the conversation where the thread is, the whole story one link away\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
