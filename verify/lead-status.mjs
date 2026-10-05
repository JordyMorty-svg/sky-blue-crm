// What the lead page says when a save is refused: node verify/lead-status.mjs
//
// This exists because of one afternoon. Marking a lead Lost failed, and the
// page said "Couldn't save. Try again." Trying again failed identically,
// because leads.status carried a CHECK constraint written before 'lost' was
// a status — the app offered a choice the database had never been told
// about. The only place that said so was the browser console, on a phone.
//
// So the assertions here are not about formatting. They are about whether
// the sentence on screen tells you what to DO, and in particular whether it
// ever again says "try again" to somebody for whom trying again cannot work.
//
// leadService imports the browser Supabase client, so the module is bundled
// with that import stubbed. saveProblem is pure; nothing here touches the
// network.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
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

const stub = {
  name: "stub-supabase",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const supabase = {};",
      loader: "js",
    }));
  },
};

const out = join(mkdtempSync(join(tmpdir(), "lsp-")), "bundle.mjs");
await build({
  entryPoints: ["src/services/leadService.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  plugins: [stub],
  logLevel: "warning",
});

const { saveProblem, ALL_STATUSES, LEADS_SETTABLE_STATUSES } = await import(out);

// The actual shape supabase-js hands back for the bug that started this.
const CHECK_VIOLATION = {
  code: "23514",
  message:
    'new row for relation "leads" violates check constraint "leads_status_check"',
  details: 'Failing row contains (…, lost, …).',
};

console.log("\n-- the message that cost an afternoon --\n");

{
  const msg = saveProblem(CHECK_VIOLATION, "save");
  chk("THE POINT: it does not tell you to try again",
    !/try again/i.test(msg),
    `"${msg}" — trying again fails identically every time`);
  chk("it says the value was rejected, not that the save broke",
    /rejected/i.test(msg), msg);
  chk("it names the field the constraint is on",
    /status/i.test(msg), msg);
  chk("THE POINT: it carries the database's own words through",
    msg.includes("leads_status_check"),
    "without the constraint name there is nothing to search for");
  chk("and it says what would actually fix it",
    /widen/i.test(msg), msg);
}

console.log("\n-- the other refusals worth telling apart --\n");

{
  const rls = saveProblem({ code: "42501", message: "permission denied for table leads" }, "save");
  chk("a permissions refusal is named as one, not as a glitch",
    /not allowed/i.test(rls) && !/try again/i.test(rls), rls);

  const nf = saveProblem({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, "save");
  chk("THE POINT: a read-back failure does not claim the save failed",
    /may have been saved/i.test(nf),
    "saying 'it failed' here is a lie, and the next thing anyone does is save again");
  chk("...and it says to reload rather than retry",
    /reload/i.test(nf) && !/try again/i.test(nf), nf);

  const net = saveProblem({ message: "Failed to fetch" }, "save");
  chk("a dropped connection is the one case where trying again IS the advice",
    /signal|try again/i.test(net) && /nothing was/i.test(net), net);

  const dup = saveProblem({ code: "23505", message: "duplicate key value violates unique constraint" }, "save");
  chk("a duplicate says so", /duplicate/i.test(dup), dup);

  const null_ = saveProblem({ code: "23502", message: 'null value in column "name" violates not-null constraint' }, "save");
  chk("a missing required field says so", /required field/i.test(null_), null_);
}

console.log("\n-- it still copes with nothing useful --\n");

{
  chk("an error with no code still shows its message",
    saveProblem({ message: "boom" }, "save").includes("boom"));
  chk("a bare string is passed through",
    saveProblem("boom", "save").includes("boom"));
  chk("an empty error falls back to the old sentence",
    /Couldn't save\. Try again\./.test(saveProblem(null, "save")));
  chk("the verb is the caller's", saveProblem({ message: "x" }, "delete").includes("delete"));
}

console.log("\n-- the drift that caused it in the first place --\n");
//
// The dropdown is built in JavaScript and the column is constrained in SQL.
// Nothing makes those agree, which is the whole root cause, so the least we
// can do is state the list in one place and check the migration quotes it.

{
  const all = ALL_STATUSES.map((s) => s.key);
  chk("every settable status is a real status",
    LEADS_SETTABLE_STATUSES.every((s) => all.includes(s.key)),
    LEADS_SETTABLE_STATUSES.map((s) => s.key).join(", "));

  const { readFileSync } = await import("node:fs");
  const sql = readFileSync("db/lead-status-constraint.sql", "utf8");
  const listed = [...sql.matchAll(/'([a-z_]+)'(?=[,\s\]])/g)].map((m) => m[1]);
  const missing = all.filter((s) => !listed.includes(s));
  chk("THE POINT: the migration allows every status the app can set",
    missing.length === 0,
    `db/lead-status-constraint.sql never mentions: ${missing.join(", ")} — ` +
      `which is exactly how 'lost' got into the dropdown and not into the database`);
}

console.log(bad === 0 ? "\nall ok — a refused save now says why\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
