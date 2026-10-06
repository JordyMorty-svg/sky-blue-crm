// Nobody logs a call by pressing a button: node verify/no-click-logging.mjs
//
// WHY THIS FILE EXISTS, WHICH IS THE WHOLE POINT OF IT.
//
// db/call-tracking.sql moved call logging to Quo's call.completed webhook so
// that a row appears only when a call actually happened. The UI side of that
// was removing the handlers that wrote a call on click. I removed them from
// LeadDetail and CustomerDetail, tested it, and shipped — and the CRM went
// on logging calls from the desktop, because there were THREE MORE:
//
//   src/pages/history/ContactHistory.jsx  — the Call button on the very page
//                                           whose job is to say what happened
//   src/pages/leads/Leads.jsx             — the board, which also moved the
//                                           lead to Contacted optimistically
//   src/components/LeadCard.jsx           — the card that calls it
//
// I had not seen them. My working copy of the repo was missing forty files
// and I had grepped it as though it were complete, so the search came back
// clean and I believed it.
//
// A grep I run once proves nothing about the repo. A grep the suite runs
// every time does. So this file walks the WHOLE of src/ from disk — not a
// list of files anybody maintains — and fails if any of them wires call
// logging to a press.
//
// THE RULE: a call reaches contact_log because Quo said the call happened.
// Never because somebody pressed something.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

/** Every .jsx/.js under src/, found by walking, never by a list. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

// Comments stripped before anything is matched. A check that finds the name
// it is hunting for inside the comment explaining why it is gone reports the
// opposite of the truth, and reports it green.
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const files = walk("src");

console.log(`\n-- ${files.length} files under src/ --\n`);

// A sanity check on the walk itself. A bug that made this return nothing
// would make every assertion below pass, which is the failure mode this
// whole file was written in response to.
chk("the walk actually found the app",
  files.length > 50 &&
    files.some((f) => f.endsWith("LeadDetail.jsx")) &&
    files.some((f) => f.endsWith("Leads.jsx")) &&
    files.some((f) => f.endsWith("ContactHistory.jsx")) &&
    files.some((f) => f.endsWith("LeadCard.jsx")),
  `${files.length} files — an empty walk makes every check below pass`);

console.log("\n-- nothing in the app logs a call --\n");

{
  // The two functions that write a call row, and the names they are imported
  // under. ContactHistory's "Log a contact" FORM is allowed to call
  // recordContact — a person deliberately writing down what happened is a
  // different act from a button guessing — so the rule is about what is
  // wired to a press, not about the import existing.
  const offenders = [];

  for (const file of files) {
    const src = strip(readFileSync(file, "utf8"));

    // An onClick (or an onClick handler) that reaches a logging call.
    // Matched on the handler BODY rather than on the attribute, because the
    // real cases were `onClick={handleCall}` with the write one function
    // away — which an attribute-level regex sails straight past.
    for (const m of src.matchAll(
      /(?:async\s+)?function\s+(\w*(?:[Cc]all|[Cc]ontact|[Dd]ial)\w*)\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{0,2}\}/g
    )) {
      const [, name, body] = m;
      if (/recordContact|recordLeadContact|record_lead_contact|record_contact\b/.test(body)) {
        // Allowed: the explicit "log a contact" form, which is a person
        // choosing to write a row, not a side effect of dialling.
        if (/handleSaveLog|logKind|p_detail|detail:/.test(body)) continue;
        offenders.push(`${file}: ${name}() writes a contact log`);
      }
    }

    // The optimistic board patch: bumping contact_attempts in local state so
    // the card moves before anything has happened. Its own failure mode —
    // the row moves, the call never connects, and nothing puts it back.
    if (/contact_attempts:\s*\(?[\w.]+\s*\|\|\s*0\)?\s*\+\s*1/.test(src)) {
      offenders.push(`${file}: bumps contact_attempts in the browser`);
    }
  }

  chk("THE POINT: no press anywhere in src/ writes a call to the log",
    offenders.length === 0,
    offenders.join("\n        ") +
      "\n        a call reaches contact_log when Quo says the call happened");
}

console.log("\n-- every Call button goes through Quo --\n");

{
  // A raw tel: link hands the number to the device's own dialler. That is
  // the personal phone in somebody's pocket: the customer sees a private
  // number, and Quo never learns the call happened, so nothing can ever
  // confirm it. Allowed only as a fallback BESIDE quoCallHref, for a number
  // Quo cannot dial.
  const offenders = [];

  for (const file of files) {
    const src = strip(readFileSync(file, "utf8"));

    // The public quote page is the customer ringing US on a number printed
    // in the page. Not a CRM call button and not ours to route.
    if (file.includes("PublicQuote")) continue;
    // leadService.js DEFINES both helpers; it is the one file allowed to
    // mention telHref without a quoCallHref beside it.
    if (file.endsWith("services/leadService.js")) continue;

    // Two shapes, because the first version of this check only knew one.
    //
    // A tel: written inline — href={`tel:${phone}`}.
    for (const m of src.matchAll(/href=\{[^}]*tel:[^}]*\}/g)) {
      if (!/quoCallHref/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 70)}`);
    }

    // AND a tel: built one function away — `const phone = telHref(x)`, used
    // later as href={phone}. That is how the real Call buttons were
    // written, so a check that only knew the inline shape passed while the
    // card and the history page both dialled straight out of the handset.
    for (const m of src.matchAll(/telHref\s*\(/g)) {
      const around = src.slice(Math.max(0, m.index - 90), m.index + 40);
      if (!/quoCallHref/.test(around)) {
        offenders.push(`${file}: telHref() with no quoCallHref beside it`);
      }
    }
  }

  chk("THE POINT: no Call button dials without offering Quo first",
    offenders.length === 0,
    offenders.join("\n        ") +
      "\n        a tel: link uses the phone's own dialler, so the customer sees a " +
      "private number and Quo never knows the call happened");
}

console.log("\n-- and the webhook is still the thing that writes them --\n");

{
  // SQL comments stripped. Commenting the revoke out leaves its text in the
  // file, so a check run against the raw source passes on a database where
  // the browser can write any call it likes.
  const sql = readFileSync("db/call-tracking.sql", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "");

  chk("record_quo_call exists and is what the webhook calls",
    /create or replace function public\.record_quo_call/.test(sql) &&
      /record_quo_call/.test(readFileSync("netlify/functions/quo-calls.mjs", "utf8")));

  // If this ever becomes callable from the browser, every check above is
  // decoration: the UI could write an invented call directly.
  chk("THE POINT: the browser still cannot write an arbitrary call",
    /revoke all on function public\.record_contact_as/.test(sql),
    "record_contact_as takes any actor, any timestamp and any outcome");
}

console.log(bad === 0
  ? "\nall ok — a call is logged because it happened, not because of a press\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
