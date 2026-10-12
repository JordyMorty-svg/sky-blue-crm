// Hiding texts on a page that already shows the thread:
//   node verify/contact-texts.mjs
//
// On LeadComms and CustomerComms the text thread and the history timeline
// sit on the same screen, so every text renders twice and the calls,
// emails, status moves and job milestones — the things the thread CANNOT
// show — get pushed off the bottom by a chatty customer. The timeline now
// folds texts away behind a toggle.
//
// The risk this file exists for is not the filter. It is the THIRD PAGE.
// ContactHistory.jsx is "everything that ever happened with one person" and
// has no thread beside it; the same filter applied there silently deletes
// half its content, and it would look like a page that simply had less on
// it. Nobody would file that as a bug for months.
//
// Checks marked THE POINT are the ones this file exists for.

import { readFileSync } from "node:fs";
// From contactFilters, not contactService: the latter opens a Supabase
// client at import time and imports "../supabaseClient" with no extension,
// which Vite resolves and plain Node does not. The screens import these
// from contactService, which re-exports them.
import { isTextEvent, partitionTexts } from "../src/services/contactFilters.js";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

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

  chk("a row with no kind does not throw, and is kept",
    !isTextEvent({}) && !isTextEvent(undefined) && !isTextEvent(null),
    "an unknown kind is kept rather than hidden — a timeline that quietly " +
      "drops rows it does not recognise is one that loses the next channel " +
      "somebody adds");
}

console.log("\n-- splitting a timeline --\n");

{
  const rows = [
    { kind: "call_in", at: 1 },
    { kind: "text_in", at: 2 },
    { kind: "text", at: 3 },
    { kind: "quote", at: 4 },
    { kind: "text", at: 5 },
    { kind: "call_missed", at: 6 },
  ];

  const { rest, texts, textCount } = partitionTexts(rows);

  chk("the texts come out and everything else stays",
    rest.map((r) => r.kind).join(",") === "call_in,quote,call_missed" &&
      textCount === 3 &&
      texts.length === 3);

  chk("THE POINT: the order of what is left is untouched",
    rest.map((r) => r.at).join(",") === "1,4,6",
    "this is a timeline; reordering it is worse than filtering it");

  chk("nothing is lost — the two halves are the whole",
    rest.length + texts.length === rows.length);

  chk("an empty timeline is fine",
    partitionTexts([]).textCount === 0 && partitionTexts().textCount === 0,
    "called on every render, including the first one before the fetch lands");

  // THE COUNT IS WHY THIS RETURNS BOTH HALVES. A timeline that silently
  // drops rows is one nobody trusts; "14 texts" is one that is keeping
  // something tidy on your behalf.
  chk("THE POINT: the count of what is hidden is reported",
    partitionTexts([{ kind: "text" }, { kind: "text_in" }]).textCount === 2,
    "the screen has to be able to say how many it folded away");
}

console.log("\n-- the two pages that hide them --\n");

for (const page of ["src/pages/leads/LeadComms.jsx", "src/pages/customers/CustomerComms.jsx"]) {
  const src = strip(readFileSync(page, "utf8"));
  const name = page.split("/").pop();

  chk(`${name} renders the filtered list, not the raw one`,
    /shownRows\.map\(/.test(src) && !/\brows\.map\(/.test(src),
    "mapping `rows` straight back would leave the filter computed and unused, " +
      "which looks exactly like a working filter in a diff");

  chk(`${name} starts with them hidden`,
    /useState\(false\)/.test(src) && /showTexts/.test(src));

  chk(`${name} can still show them`,
    /setShowTexts\(\(v\) => !v\)/.test(src));

  chk(`${name} says how many are hidden`,
    /\{textCount\}\s*text/.test(src),
    "a count, not just the word 'texts' — the number is what makes it read " +
      "as tidying rather than as missing data");

  // THE EMPTY STATE THAT WOULD LOOK LIKE DATA LOSS. A lead you have only
  // ever texted has a full history and nothing in this list, and "Nothing
  // recorded yet" sitting directly above a thread full of messages is the
  // kind of thing that makes somebody stop trusting the CRM.
  chk(`${name} explains an empty list that is empty only because of the filter`,
    /Only texts so far/.test(src),
    "'Nothing recorded yet' above a full thread reads as data loss");
}

console.log("\n-- the page that must NOT hide them --\n");

{
  const src = strip(readFileSync("src/pages/history/ContactHistory.jsx", "utf8"));

  chk("THE POINT: ContactHistory does not filter texts out",
    !/partitionTexts|isTextEvent|showTexts|shownRows/.test(src),
    "it is reached at /history/lead/:id as 'everything that ever happened " +
      "with one person' and has no thread beside it — filtering here deletes " +
      "half the page and looks like a page that just has less on it");

  chk("...and it still has no text thread of its own",
    !/TextThread/.test(src),
    "the day it grows one, the filter belongs there too — and this check is " +
      "what will say so");
}

console.log(bad === 0
  ? "\nall ok — tidied where the thread is, whole where it is not\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
