// Who is allowed to write leads.status from the lead form:
//   node verify/lead-status-write.mjs
//
// THE BUG. Kristina's timeline, 12 October, inside one minute:
//
//     Called · New → Contacted      3:23 PM
//     Contacted → New        Jordan 3:23 PM
//     New → Contacted               3:23 PM
//
// Nobody chose New. The lead page was open from before the call; the Quo
// webhook moved her to Contacted; pressing Save wrote the stale value back.
// The save payload named `status: draft.status`, and `draft` falls back to
// `lead` — the record AS IT WAS WHEN THE PAGE LOADED. The third row is
// refresh_call_detail putting her right again when the transcript landed,
// which only had anything to do because of the second.
//
// WHY THIS FIELD AND NOT A GENERAL FIX. Every other column in that payload
// is written by this form and nothing else, so a stale snapshot of it can
// only ever overwrite the same value with itself. Status is written by
// record_quo_call, refresh_call_detail, the pipeline board and the quote
// flow as well. It is the only one where a stale save loses somebody
// else's work, so it is the only one that has to be conditional.
//
// Checks marked THE POINT are the ones this file exists for.

import { readFileSync } from "node:fs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// COMMENTS OUT FIRST. Every check below greps the file, and the comments in
// it describe at length the thing being grepped for. Eighth time in this
// repo; it has produced a false pass at least twice.
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const raw = readFileSync("src/pages/leads/LeadDetail.jsx", "utf8");
const src = strip(raw);

console.log("\n-- the save payload --\n");

{
  chk("THE POINT: status is not named unconditionally in the payload",
    !/^\s*status: draft\.status,\s*$/m.test(src),
    "this exact line is the bug — it writes whatever the page loaded with, " +
      "over whatever the webhook has since set");

  chk("THE POINT: status is added only when somebody chose one",
    /if \(statusChosen\.current\) payload\.status = draft\.status;/.test(src),
    "added to the payload object rather than named in it, so the key is " +
      "ABSENT from the update and Postgres leaves the column alone — " +
      "sending `status: undefined` would not do that");

  chk("the flag is set by the status select, and only there",
    (src.match(/statusChosen\.current = true/g) || []).length === 1 &&
      /onChange=\{\(e\) => \{\s*statusChosen\.current = true;/.test(src),
    "set anywhere else — on mount, on any field — and the stale write is " +
      "back with an extra step in front of it");

  chk("...and cleared after a successful save",
    /statusChosen\.current = false;/.test(src),
    "the form reloads from the record afterwards, so the next save has to " +
      "start over; leaving it true makes every later save write status again");

  chk("the flag is a ref, not state",
    /const statusChosen = useRef\(false\)/.test(src),
    "nothing on screen depends on it and it must survive a re-render " +
      "without causing one");

  chk("useRef is imported",
    /import \{[^}]*useRef[^}]*\} from "react"/.test(src));
}

console.log("\n-- what must NOT have changed --\n");

{
  // The payload is an explicit column list on purpose: a spread of `form`
  // would save fields nobody meant to save. Turning it into an object did
  // not change that, and this is the check that says so.
  chk("the payload is still an explicit column list, not a spread",
    !/\.\.\.(form|draft)\b/.test(src.slice(src.indexOf("const payload"))),
    "a spread saves whatever happens to be on the draft, which is how the " +
      "picker's latitude/longitude got lost the first time");

  for (const field of [
    "name", "phone", "email", "address", "latitude", "longitude",
    "stories", "windows", "interior", "estimate", "temperature",
    "source", "service", "property_type", "service_plan",
    "appointment_at", "notes", "crm_notes",
  ]) {
    chk(`${field} is still saved`,
      new RegExp(`\\b${field}:`).test(src),
      "the payload moved from an inline object to a named one, which is " +
        "exactly the edit that silently drops a line");
  }

  chk("there is still exactly ONE updateLead call in this file",
    (src.match(/await updateLead\(/g) || []).length === 1,
    "'Save changes' and 'save before sending a quote' both go through " +
      "persist(); a second copy of the payload is how they drift apart");

  chk("persist still reloads the record and clears the draft",
    /await reload\(\);/.test(src) && /setForm\(null\);/.test(src),
    "the layout holds the record and the tab strip reads from it");
}

console.log(bad === 0
  ? "\nall ok — the form writes status only when somebody chose one\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
