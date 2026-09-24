// Every file in db/ must be plain SQL that the Supabase SQL editor accepts.
//
// This exists because db/quote-sender-name.sql and db/email-delivery.sql
// shipped with `\set ON_ERROR_STOP on` at the top, copied from the verify/
// files where it belongs. psql reads that as a meta-command and obeys it.
// The Supabase editor does not read meta-commands at all — it sends what you
// paste straight to Postgres, which answers
//
//     ERROR: 42601: syntax error at or near "\"
//
// on line 1 and runs nothing.
//
// The failure is total, immediate, and says nothing about what is actually
// wrong, and it cost Jordan a round trip. Nothing else would have caught it:
// every local test runs through psql, which handles those lines perfectly.
//
// db/*.sql are migrations, pasted into a browser. verify/*.sql are run
// through psql. Only the second kind may use meta-commands.
import { readdirSync, readFileSync } from "node:fs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

const files = readdirSync("db").filter((f) => f.endsWith(".sql")).sort();
chk("there are migrations to check", files.length > 0, `${files.length} found`);

for (const f of files) {
  const lines = readFileSync(`db/${f}`, "utf8").split("\n");

  // A backslash in the first column, outside a string or comment, is a psql
  // meta-command. Inside a dollar-quoted function body it could be a regex,
  // so only column 0 counts — which is where psql looks too.
  const offenders = lines
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /^\\/.test(line));

  chk(
    `db/${f} has no psql meta-commands`,
    offenders.length === 0,
    offenders.map((o) => `line ${o.n}: ${o.line.trim()}`).join("; ")
  );
}

// And the other half of the rule: verify/*.sql that delete rows SHOULD have
// the guard. Losing that is how a paste into Supabase empties a table.
const guarded = readdirSync("verify").filter((f) => f.endsWith(".sql"));
for (const f of guarded) {
  const body = readFileSync(`verify/${f}`, "utf8");
  const destructive = /\b(drop table|delete from)\b/i.test(body);
  if (!destructive) continue;
  chk(
    `verify/${f} refuses to run against a real database`,
    body.includes("_scratch_db"),
    "it deletes rows and has no scratch-database guard"
  );
}

console.log(bad === 0 ? "\nMigrations are pasteable" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
