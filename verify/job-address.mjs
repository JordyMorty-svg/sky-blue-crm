// Where is this job: node verify/job-address.mjs
//
// jobAddress() in src/services/jobAddress.js and public.sb_job_address() in
// db/properties.sql answer the same question in two languages. If they ever
// answer it differently, the screen and the invoice disagree about which
// house you cleaned — and because each is internally consistent, nothing
// looks wrong from either side.
//
// So this file does two jobs:
//
//   1. behaviour — the same cases verify/properties.sql puts through the
//      SQL, put through the JS
//   2. drift — reads db/properties.sql and checks the ladder in the SQL is
//      still the ladder in the JS, so reordering one without the other
//      fails here rather than in somebody's invoice
//
// Checks marked THE POINT are the ones this file exists for.

import { readFileSync } from "node:fs";
import { jobAddress, jobAddressText, addressIsFrozen } from "../src/services/jobAddress.js";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

// The fixtures from verify/properties.sql, in object form.
const MODEL_HOME = { address: "100 Model Home Way, Corvallis, OR", latitude: 44.5646, longitude: -123.262 };
const MAIN_HOUSE = { address: "742 Evergreen Terrace, Corvallis, OR", latitude: 44.57, longitude: -123.28 };
const MOVED      = { address: "55 Somewhere Else Ave, Albany, OR", latitude: 44.6365, longitude: -123.1059 };
const LEAD_TYPO  = { address: "OLD typo address", latitude: 1, longitude: 2 };

console.log("\n-- the ladder --\n");

{
  // Two jobs, one customer, two buildings. The whole feature.
  const modelHomeJob = { property: MODEL_HOME, customer: MODEL_HOME, lead: LEAD_TYPO };
  const mainHouseJob = { property: MAIN_HOUSE, customer: MODEL_HOME, lead: LEAD_TYPO };

  chk("THE POINT: two jobs for one customer sit at two different addresses",
    jobAddress(modelHomeJob).address === MODEL_HOME.address &&
      jobAddress(mainHouseJob).address === MAIN_HOUSE.address,
    "one customer, one invoice trail, two buildings");

  chk("THE POINT: the coordinates belong to the same building as the address",
    jobAddress(mainHouseJob).latitude === 44.57 &&
      jobAddress(mainHouseJob).longitude === -123.28,
    "taking the street from the property and the pin from the customer sends " +
      "the van to the wrong house with the right name on the screen, and the " +
      "driver trusts the map and stops reading");

  chk("a job with no property falls back to the customer",
    jobAddress({ customer: MODEL_HOME, lead: LEAD_TYPO }).address === MODEL_HOME.address);

  chk("THE POINT: the customer record outranks the lead",
    jobAddress({ customer: MODEL_HOME, lead: LEAD_TYPO }).source === "customer",
    "JobDetail read lead-first while JobRecord, ConfirmVisit, taxService and " +
      "navigation read customer-first — two screens, two addresses, same job");

  chk("a lead-only job still has an address",
    jobAddress({ lead: LEAD_TYPO }).address === "OLD typo address");

  chk("a job with nothing at all does not throw",
    jobAddress({}).address === null && jobAddress(undefined).address === null);
}

console.log("\n-- frozen beats everything live --\n");

{
  // The customer moved after the job was done. The job did not move.
  const finished = {
    address: MAIN_HOUSE.address,
    latitude: MAIN_HOUSE.latitude,
    longitude: MAIN_HOUSE.longitude,
    property: MOVED,
    customer: MOVED,
    lead: LEAD_TYPO,
  };

  chk("THE POINT: a finished job keeps the address it was done at",
    jobAddress(finished).address === MAIN_HOUSE.address,
    "the customer moved house; the job we already did and invoiced did not " +
      "move with them, and neither did the mileage claimed for it");

  chk("...including its coordinates",
    jobAddress(finished).latitude === MAIN_HOUSE.latitude,
    "a frozen address with live coordinates is the worst of both");

  chk("...and it says so",
    addressIsFrozen(finished) === true &&
      addressIsFrozen({ property: MAIN_HOUSE }) === false,
    "the screens use this to explain why an upcoming visit can be moved and " +
      "a finished one cannot — a disabled control with no reason reads as a bug");
}

console.log("\n-- empty is empty, whatever shape it arrives in --\n");

{
  // THE ROWS THIS ACTUALLY SEES. A customer created by the Google LSA import
  // with no address has "", a hand-edited one can end up with "   ", and
  // Supabase returns null for a join that matched nothing. All three mean
  // the same thing and only one of them is falsy in a way that reads
  // obviously.
  chk("THE POINT: a blank address falls through to the next rung",
    jobAddress({ property: { address: "" }, customer: MODEL_HOME }).source === "customer");

  chk("...and so does a whitespace one",
    jobAddress({ property: { address: "   " }, customer: MODEL_HOME }).source === "customer",
    "an address of three spaces is not an address, and something upstream " +
      "writes them");

  chk("the address comes back trimmed",
    jobAddress({ customer: { address: "  12 Elm St  " } }).address === "12 Elm St");

  chk("jobAddressText keeps each caller's own wording",
    jobAddressText({}, "No address") === "No address" && jobAddressText({}) === "");

  // Coordinates of zero are a real place in the Atlantic, but they are also
  // what a half-filled row looks like — navigation.js already says so. What
  // matters here is only that 0 is not treated as missing by this file.
  chk("a latitude of 0 is passed through, not swallowed",
    jobAddress({ customer: { address: "x", latitude: 0, longitude: 0 } }).latitude === 0,
    "?? not ||, or the equator becomes null");
}

console.log("\n-- the two implementations have not drifted --\n");

{
  // COMMENTS STRIPPED FIRST. Fifth time in this project. The comments in
  // both files quote the other file's ladder while explaining it, so a
  // check that reads the order out of the source matches the explanation
  // instead of the code.
  const sql = readFileSync("db/properties.sql", "utf8").replace(/--[^\n]*/g, "");
  const js = readFileSync("src/services/jobAddress.js", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  // The live ladder, as the SQL actually orders it.
  const live = sql.slice(sql.indexOf("sb_job_address_live"), sql.indexOf("create or replace function public.sb_job_address("));

  // ONLY THE ADDRESS COALESCE. The two coordinate CASE blocks below it walk
  // the same aliases in the same order, so matching the whole function
  // returned property > customer > lead > property > customer > property >
  // customer and the comparison was meaningless. Slicing at `case` is also
  // what makes a reordered coordinate block NOT hide behind a correct
  // address block — they are checked by the behaviour tests above.
  const addressRung = live.slice(live.indexOf("coalesce("), live.indexOf("case"));
  const sqlOrder = [...addressRung.matchAll(/coalesce\((\w)\.address/g)].map((m) => m[1]);

  const SQL_ALIAS = { p: "property", c: "customer", l: "lead" };
  const sqlLadder = sqlOrder.map((a) => SQL_ALIAS[a]).filter(Boolean);

  // The JS ladder, as the rungs array actually orders it.
  const rungs = js.slice(js.indexOf("const rungs = ["), js.indexOf("];", js.indexOf("const rungs = [")));
  const jsLadder = [...rungs.matchAll(/\["(\w+)",/g)].map((m) => m[1]).filter((n) => n !== "job");

  chk("THE POINT: the SQL and the JS walk the same ladder, in the same order",
    sqlLadder.length === 3 && sqlLadder.join(" > ") === jsLadder.join(" > "),
    `SQL: ${sqlLadder.join(" > ") || "(not found)"}\n        JS:  ${jsLadder.join(" > ") || "(not found)"}`);

  chk("...and the JS checks the frozen column first",
    /\["job", job\]/.test(rungs) && rungs.indexOf('"job"') < rungs.indexOf('"property"'),
    "sb_job_address() puts the frozen address above the live ladder; this " +
      "file has to as well or a completed job moves on screen but not on the " +
      "invoice");

  chk("the SQL still freezes from the LIVE chain, not the public function",
    /sb_job_address_live\(new\.id\)/.test(sql),
    "a freeze trigger that calls sb_job_address() reads the job's own frozen " +
      "column back out and writes it straight back, so the guard against " +
      "re-freezing does nothing and no test can tell");
}

console.log(bad === 0
  ? "\nall ok — the screen and the invoice name the same house\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
