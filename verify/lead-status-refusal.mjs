// Does db/lead-status-constraint.sql refuse rather than half-apply?
//
//   PSQL="psql" node verify/lead-status-refusal.mjs
//
// The migration drops a CHECK constraint and adds a wider one. Those are two
// statements, and the failure mode worth guarding is the one between them:
// if a lead already holds a status the new list does not cover, the ADD
// fails, and a careless version would leave the table with the old
// constraint gone and nothing in its place. The column would then accept
// anything, every assertion in verify/lead-status.sql would still pass, and
// nobody would find out until a typo became a status.
//
// So the migration checks first and raises before touching anything. That
// guard cannot be tested from verify/lead-status.sql, because by the time
// that file runs the migration has already succeeded. This drives psql
// directly and runs the REAL migration file against a seeded conflict.
//
// Needs the same throwaway Postgres as the other SQL suites. PGDATABASE is
// created and dropped by this file (default sb_refusal); PSQL overrides how
// psql is invoked.

import { spawnSync } from "node:child_process";

const DB = process.env.PGDATABASE || "sb_refusal";
const PSQL = (process.env.PSQL || "psql").split(" ");

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// spawnSync, not execFileSync, because psql writes its NOTICEs to stderr and
// execFileSync only hands back stderr when the command FAILS. The first
// version of this missed every successful "now allows..." notice and reported
// a passing migration as a failure.
function psql(args, { db = DB, allowFail = false } = {}) {
  const r = spawnSync(PSQL[0], [...PSQL.slice(1), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], {
    encoding: "utf8",
  });
  const out = String(r.stdout || "") + String(r.stderr || "");
  if (r.status !== 0 && !allowFail) {
    throw new Error(`psql failed (${r.status}):\n${out}`);
  }
  return out;
}

psql(["-c", `drop database if exists ${DB}`], { db: "postgres" });
psql(["-c", `create database ${DB}`], { db: "postgres" });

try {
  psql(["-f", "verify/sms-fixture.sql"]);
  psql(["-f", "verify/lead-status-legacy.sql"]);

  // A status nobody planned for. Real versions of this: a hand-edited row, a
  // status that existed once and was renamed, an import from a spreadsheet.
  psql([
    "-c",
    `alter table leads drop constraint leads_status_check;
     insert into leads (name, status) values ('Legacy row', 'on_hold');
     alter table leads add constraint leads_status_check
       check (status in ('new','contacted','quoted','booked','scheduled','completed','on_hold'));`,
  ]);

  const before = psql([
    "-tAc",
    `select pg_get_constraintdef(c.oid) from pg_constraint c
       join pg_class r on r.oid = c.conrelid
      where r.relname = 'leads' and c.conname = 'leads_status_check'`,
  ]).trim();

  const out = psql(["-f", "db/lead-status-constraint.sql"], { allowFail: true });

  chk("THE POINT: it refuses rather than running the drop and failing after",
    /REFUSING/.test(out),
    out.split("\n").slice(0, 3).join(" "));
  chk("...and names the status that stopped it",
    /on_hold/.test(out), out.split("\n")[0]);
  chk("...and says what to do about it",
    /Add it to `allowed`|fix those rows/.test(out), out.split("\n")[0]);

  const after = psql([
    "-tAc",
    `select coalesce(
       (select pg_get_constraintdef(c.oid) from pg_constraint c
          join pg_class r on r.oid = c.conrelid
         where r.relname = 'leads' and c.conname = 'leads_status_check'),
       '(GONE)')`,
  ]).trim();

  chk("THE POINT: the old constraint is still there, untouched",
    after === before,
    after === "(GONE)"
      ? "the column is now unprotected — a half-applied migration is worse than one that refused"
      : `before: ${before}\n        after:  ${after}`);

  // And the column still enforces it.
  const stillGuards = psql(["-c", `update leads set status = 'banana' where name = 'Legacy row'`], {
    allowFail: true,
  });
  chk("...and the column still rejects nonsense",
    /violates check constraint/.test(stillGuards), stillGuards.split("\n")[0]);

  // Now do what the message says, and it should apply.
  //
  // BOTH halves, which is the part worth spelling out. Moving the row off
  // 'on_hold' is not enough on its own: the constraint still PERMITS
  // 'on_hold', and the second guard refuses on that alone. Retiring a status
  // properly means moving the rows AND taking it out of the constraint.
  //
  // The row goes to 'quoted', not 'archived' — the old constraint is still in
  // force here and in this fixture it does not allow 'archived' either. That
  // is the bug this whole file is about, and the first version of this line
  // walked straight into it.
  psql(["-c", `update leads set status = 'quoted' where status = 'on_hold'`]);
  psql([
    "-c",
    `alter table leads drop constraint leads_status_check;
     alter table leads add constraint leads_status_check
       check (status in ('new','contacted','quoted','booked','scheduled','completed'));`,
  ]);
  const second = psql(["-f", "db/lead-status-constraint.sql"], { allowFail: true });
  chk("THE POINT: once the row is fixed, the same file applies cleanly",
    !/REFUSING|ERROR/.test(second) && /now allows/.test(second),
    second.split("\n").slice(0, 3).join(" "));

  const lost = psql(["-c", `update leads set status = 'lost' where name = 'Legacy row'`], { allowFail: true });
  chk("...and a lead can finally be marked lost",
    !/ERROR/.test(lost), lost.split("\n")[0]);
  // --- the second way the new list can be wrong ---------------------------
  //
  // A status the OLD CONSTRAINT permitted that nothing currently holds.
  // Checking the rows alone would miss it entirely: the column would be
  // quietly narrowed, and the next lead that needed that status would fail
  // exactly the way 'lost' just did.
  psql(["-c", `drop database if exists ${DB}_b`], { db: "postgres" });
  psql(["-c", `create database ${DB}_b`], { db: "postgres" });
  const B = { db: `${DB}_b` };

  psql(["-f", "verify/sms-fixture.sql"], B);
  psql([
    "-c",
    `alter table leads add constraint leads_status_check
       check (status in ('new','contacted','quoted','booked','scheduled',
                         'completed','archived','on_hold'));`,
  ], B);
  // Note: NO lead holds 'on_hold'. That is the point.

  const narrowed = psql(["-f", "db/lead-status-constraint.sql"], { ...B, allowFail: true });

  chk("THE POINT: it refuses to drop a status the constraint allowed but nothing uses",
    /REFUSING/.test(narrowed) && /on_hold/.test(narrowed),
    "no row holding a status proves nothing about whether the column may hold it\n        " +
      narrowed.split("\n").slice(0, 2).join(" "));
  chk("...and says it would narrow rather than widen",
    /narrow/.test(narrowed), narrowed.split("\n")[0]);

  const defB = psql([
    "-tAc",
    `select coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
        join pg_class r on r.oid = c.conrelid
       where r.relname = 'leads' and c.conname = 'leads_status_check'), '(GONE)')`,
  ], B).trim();
  chk("...and left the old constraint alone",
    defB.includes("on_hold"), defB);

  psql(["-c", `drop database if exists ${DB}_b`], { db: "postgres" });

  // Sanity: the real-world case. Jordan's constraint allows everything except
  // 'lost', so the file must NOT refuse on it.
  psql(["-c", `drop database if exists ${DB}_c`], { db: "postgres" });
  psql(["-c", `create database ${DB}_c`], { db: "postgres" });
  const C = { db: `${DB}_c` };
  psql(["-f", "verify/sms-fixture.sql"], C);
  psql([
    "-c",
    `alter table leads add constraint leads_status_check
       check (status in ('new','contacted','quoted','booked','scheduled',
                         'completed','archived'));
     insert into leads (name, status) values
       ('a','archived'), ('b','completed'), ('c','contacted'),
       ('d','quoted'), ('e','scheduled');`,
  ], C);

  const real = psql(["-f", "db/lead-status-constraint.sql"], { ...C, allowFail: true });
  chk("THE POINT: the constraint actually on Sky Blue's database applies cleanly",
    !/REFUSING|ERROR/.test(real) && /now allows/.test(real),
    real.split("\n").slice(0, 3).join(" "));

  const marked = psql(["-c", `update leads set status = 'lost' where name = 'd'`], { ...C, allowFail: true });
  chk("...and Kathy O'Reilly can be marked lost afterwards",
    !/ERROR/.test(marked), marked.split("\n")[0]);

  psql(["-c", `drop database if exists ${DB}_c`], { db: "postgres" });

  // --- the OTHER way Postgres renders a constraint -------------------------
  //
  // Everything above seeds `status in ('a','b')`, which Postgres stores as
  // ARRAY['a'::text, 'b'::text]. This file itself writes `= any('{a,b}')`,
  // which stores as a single brace literal and matches none of the quoted
  // patterns. So the branch that unpacks THAT form is only ever exercised on
  // a second run against a database this migration has already touched —
  // which is to say, on every database after the first time, and on none of
  // the tests above. Hence this one.
  psql(["-c", `drop database if exists ${DB}_d`], { db: "postgres" });
  psql(["-c", `create database ${DB}_d`], { db: "postgres" });
  const D = { db: `${DB}_d` };
  psql(["-f", "verify/sms-fixture.sql"], D);
  psql([
    "-c",
    `alter table leads add constraint leads_status_check
       check (status = any('{new,contacted,quoted,booked,scheduled,completed,archived,weird_one}'::text[]));`,
  ], D);

  const braces = psql(["-f", "db/lead-status-constraint.sql"], { ...D, allowFail: true });
  chk("THE POINT: it can read the brace-array rendering too, not just quoted literals",
    /REFUSING/.test(braces) && /weird_one/.test(braces),
    "this is the form the file writes itself, so missing it means the guard " +
      "is blind on every run after the first\n        " +
      braces.split("\n").slice(0, 2).join(" "));

  psql(["-c", `drop database if exists ${DB}_d`], { db: "postgres" });
} finally {
  psql(["-c", `drop database if exists ${DB}`], { db: "postgres" });
}

console.log(bad === 0 ? "\nall ok — it refuses cleanly and leaves the table guarded\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
