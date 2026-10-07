// What the timeline calls the person: node verify/contact-wording.mjs
//
// Three kinds of row on the contact timeline describe something the CUSTOMER
// did — they rang, they rang and we missed it, they replied — and all three
// used to say "they". That reads fine on a page you opened on purpose and
// badly everywhere else, because the thread is keyed on the PHONE NUMBER:
// one conversation is routinely a lead from April, a second lead from June
// and a customer, and "They called" does not say which of them called.
//
// THE FAILURE THIS FILE IS REALLY ABOUT is not the wording. It is the wire.
// TextThread already accepted a `theirName` prop, both pages already passed
// it, and for a while the component did not destructure it — so every bubble
// said "Them" while the prop sailed past, and nothing anywhere went red. A
// name that is threaded through four files has four places to be dropped
// silently. The last section walks src/ from disk and checks the ends match.
//
// Checks marked THE POINT are the ones this file exists for.

import { build } from "esbuild";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "wording-"));
const out = "verify/.contact-wording-bundle.mjs";

await build({
  entryPoints: [join(dir, "entry.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  plugins: [
    {
      name: "entry",
      setup(b) {
        b.onResolve({ filter: /entry\.js$/ }, (a) => ({ path: a.path, namespace: "e" }));
        b.onLoad({ filter: /.*/, namespace: "e" }, () => ({
          contents: `
            export { describeEvent } from "${process.cwd()}/src/services/contactService.js";
            export { firstName } from "${process.cwd()}/src/services/names.js";
            export { describeMessage } from "${process.cwd()}/src/services/textService.js";
          `,
          loader: "js",
          resolveDir: process.cwd(),
        }));
        // Nothing here touches the network; the client is only imported.
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents: "export const supabase = { rpc: async () => ({ data: [], error: null }) };",
          loader: "js",
        }));
      },
    },
  ],
  logLevel: "warning",
});

const M = await import("./.contact-wording-bundle.mjs");

console.log("\n-- the rows that are about them --\n");

{
  const row = (kind) => ({ source: "contact", kind, detail: "" });

  chk("THE POINT: an inbound call is named after whoever made it",
    M.describeEvent(row("call_in"), undefined, "Dana Reyes").title === "Dana called",
    M.describeEvent(row("call_in"), undefined, "Dana Reyes").title);

  chk("THE POINT: a missed call reads as a possessive, not a template",
    M.describeEvent(row("call_missed"), undefined, "Dana Reyes").title ===
      "Missed Dana's call",
    M.describeEvent(row("call_missed"), undefined, "Dana Reyes").title +
      " — a single {name} placeholder would have produced 'Missed Dana call'");

  chk("a reply is named too",
    M.describeEvent(row("text_in"), undefined, "Dana Reyes").title === "Dana replied");

  // FIRST NAME. "Dana Reyes called" above every other line is a database
  // field on a screen.
  chk("only the first name is used",
    !M.describeEvent(row("call_in"), undefined, "Dana Reyes").title.includes("Reyes"));
}

console.log("\n-- and when there is no name --\n");

{
  const row = (kind) => ({ source: "contact", kind, detail: "" });

  // A lead from the website form with a phone number and nothing else is an
  // ordinary thing, not an error state.
  for (const [kind, expected] of [
    ["call_in", "They called"],
    ["call_missed", "Missed their call"],
    ["text_in", "They replied"],
  ]) {
    chk(`${kind} falls back to the old wording with no name`,
      M.describeEvent(row(kind), undefined, null).title === expected,
      M.describeEvent(row(kind), undefined, null).title);
  }

  chk("THE POINT: a blank name is not rendered as a blank label",
    M.describeEvent(row("call_in"), undefined, "   ").title === "They called",
    M.describeEvent(row("call_in"), undefined, "   ").title +
      " — an empty string in a label reads as a rendering fault");

  chk("...and neither is undefined",
    M.describeEvent(row("call_in")).title === "They called");
}

console.log("\n-- the rows that are about us are left alone --\n");

{
  const row = (kind) => ({ source: "contact", kind, detail: "" });

  // THE POINT, pointed the other way. "Dana Called" on a row where Sky Blue
  // rang out would be worse than "They called" ever was.
  for (const [kind, expected] of [
    ["call", "Called"],
    ["call_attempt", "Called, no answer"],
    ["text", "Texted"],
    ["email", "Emailed"],
    ["auto_email", "Automatic email"],
    ["note", "Note"],
  ]) {
    chk(`${kind} is still described as something Sky Blue did`,
      M.describeEvent(row(kind), undefined, "Dana Reyes").title === expected,
      M.describeEvent(row(kind), undefined, "Dana Reyes").title);
  }

  // A status move still rides on the same line.
  const moved = {
    source: "contact",
    kind: "call_in",
    from_status: "new",
    to_status: "contacted",
  };
  chk("a call that also moved the lead still says so, with the name",
    M.describeEvent(moved, (s) => s, "Dana Reyes").title === "Dana called · new → contacted",
    M.describeEvent(moved, (s) => s, "Dana Reyes").title);
}

console.log("\n-- the thread agrees with the timeline --\n");

{
  // Two services, one person. They used to hold separate copies of
  // firstName(); now they share src/services/names.js, and this is the check
  // that the sharing is real rather than two functions that agree today.
  const bubble = M.describeMessage({ direction: "in", kind: "inbound" }, "Dana Reyes");
  const timeline = M.describeEvent(
    { source: "contact", kind: "text_in", detail: "" }, undefined, "Dana Reyes");

  chk("THE POINT: the bubble and the timeline call her the same thing",
    bubble.who === "Dana" && timeline.title.startsWith("Dana"),
    `${bubble.who} / ${timeline.title}`);

  chk("an outgoing bubble is still Sky Blue, not the customer",
    M.describeMessage({ direction: "out", kind: "manual" }, "Dana Reyes").who === "Sky Blue");

  chk("firstName is one function, exported from one place",
    M.firstName("Dana Reyes") === "Dana" && M.firstName("  ") === null);
}

console.log("\n-- the wire, walked from disk --\n");

// WHY THIS WALKS THE FILESYSTEM. A name threaded through four files has four
// places to be dropped, and dropping one is invisible: the prop is passed,
// nothing errors, and the label quietly says "Them" forever. That is exactly
// what happened to TextThread's theirName. A hand-maintained list of call
// sites would have the same hole, so the list is the directory.
{
  const files = [];
  (function walk(d) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry)) files.push(full);
    }
  })("src");

  chk("the walk found the app",
    files.length > 20,
    `${files.length} files — a broken walk makes every check below pass`);

  const callers = [];
  const threads = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    // COMMENTS STRIPPED FIRST. This file's own prose explains describeEvent()
    // at length, and the first version of this walk counted those sentences
    // as call sites and reported the services as broken pages. A check that
    // reads the explanation instead of the code is worse than no check.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

    for (const m of src.matchAll(/describeEvent\(([^)]*)\)/g)) {
      // The definition itself, not a call.
      if (/(function|=>)\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      if (/export function describeEvent/.test(src.slice(Math.max(0, m.index - 24), m.index + 1))) continue;
      callers.push({ file, args: m[1] });
    }
    if (/<TextThread/.test(src)) {
      threads.push({ file, props: src.slice(src.indexOf("<TextThread")) });
    }
  }

  chk("every page that shows a timeline was found",
    callers.length >= 3,
    callers.map((c) => c.file).join(", "));

  const bare = callers.filter((c) => c.args.split(",").length < 3);
  chk("THE POINT: no page renders the timeline without passing a name",
    bare.length === 0,
    bare.map((c) => `${c.file}: describeEvent(${c.args})`).join("; ") +
      " — the row will say 'They called' and nothing will go red");

  chk("every TextThread is given a name too",
    threads.length > 0 && threads.every((t) => /theirName=/.test(t.props)),
    threads.map((t) => t.file).join(", "));

  // THE OTHER END OF THE WIRE. The prop being passed means nothing if the
  // component does not read it — which is the bug this file was written
  // after, where theirName was passed by both pages and ignored.
  // COMMENTS STRIPPED, for the third time in this project and for the same
  // reason each time. A mutation run commented the prop out — `// theirName`
  // still contains the word, and the check passed against prose describing
  // the thing it was asserting.
  const thread = readFileSync("src/components/TextThread.jsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  // The component's own parameter list, not the whole file: the prop has to
  // be DESTRUCTURED, which is the step that was missing.
  const params = thread.slice(
    thread.indexOf("export default function TextThread({"),
    thread.indexOf("}", thread.indexOf("export default function TextThread({"))
  );
  chk("THE POINT: and TextThread actually reads it",
    /theirName/.test(params) && /describeMessage\(row, theirName\)/.test(thread),
    "the prop was passed by both pages and never destructured; every bubble " +
      "said 'Them' and no test anywhere went red");
}

console.log(bad === 0 ? "\nall ok — the person on the timeline has a name\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
