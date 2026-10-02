// Does the CRM's idea of "email or text?" match the database's?
//
//   node verify/follow-up-route.mjs
//
// The Communication page greys out customers who can't be asked and labels
// the rest Email or Text. To do that it has to answer the same question
// sb_follow_up_channel() answers in db/follow-ups.sql — so reviewRoute() in
// src/services/followUpService.js is a MIRROR of a database rule, which is a
// liability with a known failure mode: somebody changes one side.
//
// The failure is quiet and it is the expensive kind. A mirror that says
// "Text" where the database says null greys nothing out and the button
// throws. A mirror that says null where the database says "sms" greys out a
// customer who could perfectly well have been asked — which is exactly the
// bug this whole feature was fixing, reintroduced in the UI.
//
// So: one table of cases, run through BOTH, compared. Not two tables.
//
// Needs a throwaway Postgres with the schema loaded, same as
// verify/follow-ups.sql:
//   verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,
//   verify/follow-up-fixture.sql, db/follow-ups.sql
//
// PGDATABASE (default sb_fu) and PSQL (default "psql") pick the database and
// how to reach it.

import { execFileSync } from "node:child_process";

const DB = process.env.PGDATABASE || "sb_fu";
const PSQL = (process.env.PSQL || "psql").split(" ");

// The STOP list, as the fixture will hold it and as the page would have
// fetched it. One number, opted out.
const STOPPED_RAW = "5415550144";
const STOPPED_E164 = "+15415550144";

/*
 * Every case worth asking about, including the ones nobody would think to
 * type: a number too short to dial, an area code starting with 1, an email
 * that is only spaces.
 *
 * `email_opt_out` is in here three times on purpose — with an address, with
 * only a number, and with both — because "an unsubscribe closes the text
 * route too" is the single condition most likely to be simplified away by
 * somebody who reads the unsubscribe wording literally.
 */
const CASES = [
  { why: "address and number", email: "a@b.com", opt: false, phone: "5415550101" },
  { why: "address only", email: "a@b.com", opt: false, phone: null },
  { why: "number only", email: null, opt: false, phone: "5415550101" },
  { why: "number only, typed with punctuation", email: null, opt: false, phone: "(541) 555-0101" },
  { why: "number only, with a country code", email: null, opt: false, phone: "15415550101" },
  { why: "nothing at all", email: null, opt: false, phone: null },
  { why: "an email of only spaces", email: "   ", opt: false, phone: "5415550101" },
  { why: "an email of only spaces and no number", email: "   ", opt: false, phone: null },
  { why: "a number too short to be one", email: null, opt: false, phone: "541-730-359" },
  { why: "an area code starting with 1", email: null, opt: false, phone: "1415550101" },
  { why: "an area code starting with 0", email: null, opt: false, phone: "0415550101" },
  { why: "a note typed in the phone field", email: null, opt: false, phone: "ring the doorbell" },
  { why: "unsubscribed, with an address", email: "a@b.com", opt: true, phone: null },
  { why: "unsubscribed, with only a number", email: null, opt: true, phone: "5415550101" },
  { why: "unsubscribed, with both", email: "a@b.com", opt: true, phone: "5415550101" },
  { why: "replied STOP, no address", email: null, opt: false, phone: STOPPED_RAW },
  { why: "replied STOP, but we have an address", email: "a@b.com", opt: false, phone: STOPPED_RAW },
  { why: "replied STOP, typed differently", email: null, opt: false, phone: "(541) 555-0144" },
];

// --- the database's answer --------------------------------------------------

const lit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

const sql =
  `insert into public.sms_opt_outs (phone, source) values ('${STOPPED_E164}', 'route-test')
     on conflict (phone) do nothing;\n` +
  "select " +
  CASES.map(
    (c, i) =>
      `coalesce(public.sb_follow_up_channel(${lit(c.email)}, ${c.opt}, ${lit(c.phone)}), '-') as c${i}`
  ).join(", ") +
  ";";

let dbRow;
try {
  dbRow = execFileSync(PSQL[0], [...PSQL.slice(1), "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-d", DB, "-c", sql], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .pop()
    .split("|");
} catch (e) {
  console.log("Couldn't ask the database. Build the scratch schema first:\n");
  console.log("  verify/sms-fixture.sql, db/sms.sql, db/sms-delivery.sql,");
  console.log("  verify/follow-up-fixture.sql, db/follow-ups.sql\n");
  console.log(String(e.stderr || e.message).trim().split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}

// --- the CRM's answer -------------------------------------------------------

// followUpService imports the browser Supabase client, so the module is
// bundled with that import stubbed — same approach as verify/quote-service.mjs.
// Nothing here touches the network; the three functions under test are pure.
const { build } = await import("esbuild");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

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

const outFile = join(mkdtempSync(join(tmpdir(), "fur-")), "bundle.mjs");
await build({
  entryPoints: ["src/services/followUpService.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  plugins: [stub],
  logLevel: "warning",
});

const { reviewRoute, reviewBlockedReason, textableNumber } = await import(outFile);

const stopped = new Set([STOPPED_E164]);

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

console.log("\n-- the page and the database, on the same customers --\n");

CASES.forEach((c, i) => {
  const fromDb = dbRow[i] === "-" ? null : dbRow[i];
  const fromApp = reviewRoute(
    { email: c.email, email_opt_out: c.opt, phone: c.phone },
    stopped
  );
  chk(
    `${c.why}: ${fromDb ?? "no route"}`,
    fromApp === fromDb,
    `the page says ${fromApp ?? "no route"}, the database says ${fromDb ?? "no route"}`
  );
});

chk(
  "THE POINT: the two never disagree on any of these",
  bad === 0,
  "a mirror that drifts either greys out a customer who could be asked, or offers a button the database refuses"
);

// --- the badge wording ------------------------------------------------------

console.log("\n-- why a blocked customer is blocked --\n");

chk("an unsubscribed customer says so",
  reviewBlockedReason({ email: "a@b.com", email_opt_out: true }, stopped) === "Unsubscribed");
chk("THE POINT: a STOP reply is named, not hidden as a missing address",
  reviewBlockedReason({ email: null, phone: STOPPED_RAW }, stopped) === "Replied STOP",
  "otherwise somebody types in an email address to fix a problem that isn't that");
chk("and nothing on file says that",
  reviewBlockedReason({ email: null, phone: null }, stopped) === "No email or mobile");
chk("a customer who CAN be asked has no reason at all",
  reviewBlockedReason({ email: null, phone: "5415550101" }, stopped) === null);

console.log("\n-- the number the page would show --\n");

chk("a typed number normalises the same way the database does",
  textableNumber("(541) 555-0101") === "+15415550101", textableNumber("(541) 555-0101"));
chk("a half-typed one is not offered as textable",
  textableNumber("541-730-359") === null);
chk("THE POINT: the STOP list is matched on the normalised number",
  reviewRoute({ email: null, phone: "(541) 555-0144" }, stopped) === null,
  "matching the raw text would let the same number through typed differently");

console.log(
  bad === 0
    ? "\nall ok — the page and the database agree about who gets asked, and how\n"
    : `\n${bad} FAILED\n`
);
process.exit(bad === 0 ? 0 : 1);
