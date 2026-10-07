// The endpoint that pulls a conversation out of Quo: node verify/backfill-texts.mjs
//
// db/sms-backfill.sql decides what an imported message MEANS and
// verify/sms-backfill.sql proves that against a real Postgres. This file is
// about the other half: does the endpoint read Quo's pages correctly, does it
// refuse the things it must refuse, and does it hand the database facts
// rather than opinions?
//
// THE DANGEROUS DIRECTION HERE IS DIRECTION. Quo reports `incoming` and
// `outgoing` from the WORKSPACE's point of view, so outgoing is Sky Blue
// talking. Getting that backwards files every customer's words as our own and
// ours as theirs — and the thread still looks completely plausible, which is
// why it gets a test of its own rather than a glance.
//
// Checks marked THE POINT are the ones this file exists for.

import { asRow, fetchPage, ourNumberId } from "../netlify/functions/backfill-texts.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const QUO_FROM = "+15417303593";
const THEIRS = "+14259513646";

console.log("\n-- reading Quo's message shape --\n");

{
  // The documented shape, copied rather than paraphrased.
  const outgoing = {
    id: "AC-msg-1",
    to: [THEIRS],
    from: QUO_FROM,
    text: "Hi Jordan here from Sky Blue",
    direction: "outgoing",
    status: "delivered",
    createdAt: "2026-08-14T17:00:00.000Z",
  };
  const incoming = {
    id: "AC-msg-2",
    to: [QUO_FROM],
    from: THEIRS,
    text: "Sounds good, see you Tuesday",
    direction: "incoming",
    status: "received",
    createdAt: "2026-08-14T17:05:00.000Z",
  };

  const out = asRow(outgoing, THEIRS);
  const inc = asRow(incoming, THEIRS);

  chk("THE POINT: Quo's 'outgoing' is Sky Blue talking",
    out.outgoing === true,
    "direction is from the workspace's point of view; backwards files every " +
      "customer's words as our own and the thread still looks plausible");

  chk("THE POINT: and 'incoming' is the customer",
    inc.outgoing === false);

  chk("THE POINT: both directions record the CUSTOMER's number",
    out.phone === THEIRS && inc.phone === THEIRS,
    `${out.phone} / ${inc.phone} — sms_messages.phone is the customer in ` +
      `both directions, and sms_thread() keys on it. Recording our own ` +
      `number on outgoing messages would split one conversation in two`);

  chk("the Quo id is carried through, which is what deduplicates",
    out.sid === "AC-msg-1" && inc.sid === "AC-msg-2");

  chk("the date is the one Quo gave, not now",
    inc.at === "2026-08-14T17:05:00.000Z");

  chk("the words come across", inc.body === "Sounds good, see you Tuesday");

  // Shapes Quo has used, or might.
  chk("a `body` field is read when there is no `text`",
    asRow({ id: "x", body: "older shape", direction: "incoming" }, THEIRS).body ===
      "older shape");

  chk("`sentAt` stands in for a missing `createdAt`",
    asRow({ id: "x", text: "hi", sentAt: "2026-08-01T00:00:00Z" }, THEIRS).at ===
      "2026-08-01T00:00:00Z");

  chk("a message with no text at all becomes an empty body, not undefined",
    asRow({ id: "x", direction: "incoming" }, THEIRS).body === "",
    "import_quo_text() skips empty bodies; undefined would reach it as the " +
      "string 'undefined' and store a bubble saying so");

  // A direction nobody has seen is NOT ours. Claiming a message is Sky Blue's
  // when we do not know is the version of this bug that is hardest to spot.
  chk("THE POINT: an unrecognised direction is not treated as ours",
    asRow({ id: "x", text: "hi", direction: "unknown" }, THEIRS).outgoing === false,
    "a message filed as ours appears as a blue bubble in our voice, which " +
      "nobody reads twice");
}

console.log("\n-- which of the workspace's numbers is ours --\n");

{
  const was = { id: process.env.QUO_PHONE_NUMBER_ID, from: process.env.QUO_FROM };
  delete process.env.QUO_PHONE_NUMBER_ID;
  process.env.QUO_FROM = QUO_FROM;

  const listing = (rows) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: rows }),
  });

  let id = await ourNumberId(listing([
    { id: "PN-other", number: "+15555550000" },
    { id: "PN0GQ3RN1J", number: QUO_FROM },
  ]));
  chk("THE POINT: the number id is looked up from QUO_FROM, not configured",
    id === "PN0GQ3RN1J",
    "QUO_FROM is already set; a second variable holding the id of the same " +
      "phone number is one more thing to get wrong for no new information");

  // Quo returns numbers formatted various ways; the match is on digits.
  id = await ourNumberId(listing([{ id: "PN-fmt", number: "(541) 730-3593" }]));
  chk("...and matches however Quo formats it", id === "PN-fmt", id);

  let threw = "";
  try {
    await ourNumberId(listing([{ id: "PN-x", number: "+15555550000" }]));
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a QUO_FROM that is not on the workspace says exactly that",
    /not one of the 1 numbers/.test(threw),
    `got: ${threw || "(no error)"} — the alternative is a 404 from a ` +
      `different endpoint entirely, which sends somebody looking in the wrong place`);

  threw = "";
  try {
    await ourNumberId(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  } catch (e) {
    threw = e.message;
  }
  chk("a refused listing names the status", /401/.test(threw), threw);

  // The override exists for the day there are two numbers.
  process.env.QUO_PHONE_NUMBER_ID = "PN-forced";
  chk("QUO_PHONE_NUMBER_ID short-circuits the lookup",
    (await ourNumberId(async () => {
      throw new Error("should not have been called");
    })) === "PN-forced");

  if (was.id === undefined) delete process.env.QUO_PHONE_NUMBER_ID;
  else process.env.QUO_PHONE_NUMBER_ID = was.id;
  if (was.from === undefined) delete process.env.QUO_FROM;
  else process.env.QUO_FROM = was.from;
}

console.log("\n-- paging --\n");

{
  const seen = [];
  const page = async (url) => {
    seen.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1", text: "hi" }], nextPageToken: "tok-2" }),
    };
  };

  const first = await fetchPage({
    phoneNumberId: "PN1",
    participant: THEIRS,
    fetchImpl: page,
  });

  chk("a page comes back with its rows and its token",
    first.rows.length === 1 && first.next === "tok-2");

  const url = new URL(seen[0]);
  chk("THE POINT: the request asks for one conversation, not the whole inbox",
    url.searchParams.get("participants[]") === THEIRS,
    `participants[] = ${url.searchParams.get("participants[]")} — without it ` +
      `this imports every message the workspace has ever sent anybody`);

  chk("...from our number", url.searchParams.get("phoneNumberId") === "PN1");
  chk("...and no page token on the first call", url.searchParams.get("pageToken") === null);

  seen.length = 0;
  await fetchPage({
    phoneNumberId: "PN1",
    participant: THEIRS,
    pageToken: "tok-2",
    fetchImpl: page,
  });
  chk("a continuation carries the token",
    new URL(seen[0]).searchParams.get("pageToken") === "tok-2");

  // The end of the conversation.
  const last = await fetchPage({
    phoneNumberId: "PN1",
    participant: THEIRS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  chk("the last page reports no token, which is what stops the loop",
    last.next === null && last.rows.length === 0);

  // A body that is not JSON at all must not throw an unhelpful parse error.
  const junk = await fetchPage({
    phoneNumberId: "PN1",
    participant: THEIRS,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  chk("an unparseable page is empty, not a crash",
    junk.rows.length === 0 && junk.next === null);

  let threw = "";
  try {
    await fetchPage({
      phoneNumberId: "PN1",
      participant: THEIRS,
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a rate limit is named, because it is the one worth retrying",
    /rate limit/i.test(threw),
    threw || "(no error)");

  threw = "";
  try {
    await fetchPage({
      phoneNumberId: "PN1",
      participant: THEIRS,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
  } catch (e) {
    threw = e.message;
  }
  chk("...and any other refusal carries its status", /403/.test(threw), threw);
}

console.log("\n-- the whole import, end to end --\n");

// THE LOOP, RUN FOR REAL.
//
// A mutant that stopped telling the caller there was more history survived
// every lexical check here: the phrase it deleted appears twice in the file,
// and the test matched the other one. The endpoint is bundled with db.mjs
// stubbed and fetch replaced, so what the browser actually receives can be
// read rather than inferred from the source text.
{
  const { build } = await import("esbuild");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "backfill-"));
  const out = "verify/.backfill-bundle.mjs";

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
            contents: `export { default as handler } from "${process.cwd()}/netlify/functions/backfill-texts.mjs";`,
            loader: "js",
            resolveDir: process.cwd(),
          }));
          b.onResolve({ filter: /db\.mjs$/ }, (a) => ({ path: a.path, namespace: "db" }));
          b.onLoad({ filter: /.*/, namespace: "db" }, () => ({
            contents:
              "export async function rpc(fn, args) { (globalThis.__rpc ||= []).push({ fn, args });" +
              "  return (args?.p_rows || []).length; }" +
              "export async function rpcQuietly(fn, args) { return rpc(fn, args); }" +
              "export function supabaseHeaders() { return {}; }",
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "warning",
  });

  const { handler } = await import("./.backfill-bundle.mjs");

  const env = { ...process.env };
  process.env.QUO_FROM = QUO_FROM;
  process.env.QUO_API_KEY = "test-key";
  process.env.VITE_SUPABASE_URL = "https://example.test";
  process.env.VITE_SUPABASE_ANON_KEY = "anon";
  delete process.env.QUO_PHONE_NUMBER_ID;

  const realFetch = globalThis.fetch;

  // Nine pages available, so the five-page ceiling is actually crossed.
  const serve = (pagesAvailable) => async (url) => {
    const u = String(url);
    if (u.includes("/auth/v1/user")) {
      return { ok: true, status: 200, json: async () => ({ id: "user-1" }) };
    }
    if (u.includes("/phone-numbers")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "PN1", number: QUO_FROM }] }) };
    }
    const token = new URL(u).searchParams.get("pageToken");
    const n = token ? Number(token) : 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: `m${n}a`, text: "ours", direction: "outgoing", createdAt: "2026-08-01T10:00:00Z" },
          { id: `m${n}b`, text: "theirs", direction: "incoming", createdAt: "2026-08-01T10:01:00Z" },
        ],
        nextPageToken: n < pagesAvailable ? String(n + 1) : null,
      }),
    };
  };

  const post = (body) =>
    new Request("https://crm.skybluecleaningco.com/api/backfill-texts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify(body),
    });

  const quiet = console.log;

  // Two pages: the conversation ends before the ceiling.
  globalThis.__rpc = [];
  globalThis.fetch = serve(2);
  console.log = () => {};
  let res = await handler(post({ phone: THEIRS }));
  let data = await res.json();
  console.log = quiet;

  chk("a finished import reports what it brought in",
    data.ok === true && data.imported === 4 && data.scanned === 4,
    JSON.stringify(data));

  chk("THE POINT: ...and says the conversation is complete",
    data.more === false,
    JSON.stringify(data) + " — `more` is what the screen uses to decide " +
      "between 'press again for older' and leaving it alone");

  chk("every page was handed to the database",
    globalThis.__rpc.filter((c) => c.fn === "import_quo_texts").length === 2,
    globalThis.__rpc.map((c) => c.fn).join(", "));

  chk("...with the customer's number on every row",
    globalThis.__rpc.every((c) => (c.args.p_rows || []).every((r) => r.phone === THEIRS)));

  // Nine pages: the ceiling stops it.
  globalThis.__rpc = [];
  globalThis.fetch = serve(9);
  console.log = () => {};
  res = await handler(post({ phone: THEIRS }));
  data = await res.json();
  console.log = quiet;

  chk("THE POINT: a conversation longer than the ceiling says there is more",
    data.more === true && data.scanned === 10,
    JSON.stringify(data) + " — a half-imported conversation that reports " +
      "itself complete is the one failure here nobody would ever notice");

  chk("...and stopped at the ceiling rather than running on",
    globalThis.__rpc.filter((c) => c.fn === "import_quo_texts").length === 5,
    "pages: " + globalThis.__rpc.length);

  // Not signed in.
  globalThis.fetch = async (url) =>
    String(url).includes("/auth/v1/user")
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ data: [] }) };
  globalThis.__rpc = [];
  console.log = () => {};
  res = await handler(post({ phone: THEIRS }));
  console.log = quiet;
  chk("an unsigned request is refused with 401", res.status === 401, String(res.status));
  chk("...and nothing was read from Quo", globalThis.__rpc.length === 0);

  // A number that is not a number.
  globalThis.fetch = serve(1);
  console.log = () => {};
  res = await handler(post({ phone: "not a phone" }));
  console.log = quiet;
  chk("a bad number is refused with 400", res.status === 400, String(res.status));

  // Quo refusing. 200 with a sentence, not a blank 500.
  globalThis.fetch = async (url) =>
    String(url).includes("/auth/v1/user")
      ? { ok: true, status: 200, json: async () => ({ id: "user-1" }) }
      : { ok: false, status: 403, json: async () => ({}) };
  const realError = console.error;
  console.error = () => {};
  console.log = () => {};
  res = await handler(post({ phone: THEIRS }));
  data = await res.json();
  console.log = quiet;
  console.error = realError;

  chk("THE POINT: Quo refusing comes back as a sentence, not a blank failure",
    res.status === 200 && data.ok === false && /403/.test(data.error || ""),
    JSON.stringify(data));

  chk("a GET is refused with 405",
    (await handler(new Request("https://crm.skybluecleaningco.com/api/backfill-texts")))
      .status === 405);

  globalThis.fetch = realFetch;
  delete globalThis.__rpc;
  for (const k of ["QUO_FROM", "QUO_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

console.log("\n-- the rules that must not break --\n");

{
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("netlify/functions/backfill-texts.mjs", "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  const entry = src.slice(src.indexOf("export default async (req)"));

  // THE ENDPOINT HOLDS NO POLICY. Everything about what an imported message
  // means lives in db/sms-backfill.sql, where it is tested against a real
  // Postgres. A second opinion here would be a second way for a message to
  // land in the thread, with none of those rules attached.
  chk("THE POINT: the endpoint does not decide whether an import counts as outreach",
    !/contact_attempts|last_contacted_at|record_app_sms|record_inbound_sms/.test(src),
    "that judgement is import_quo_text()'s, next to the data");

  chk("...and writes only through the one import function",
    (src.match(/rpc\(\s*"/g) || []).length === 1 &&
      /rpc\(\s*"import_quo_texts"/.test(src));

  // Authentication before anything reaches Quo.
  const auth = entry.indexOf("whoIs(req)");
  const work = entry.indexOf("ourNumberId(");
  chk("THE POINT: nobody signed out can make this call Quo",
    auth > -1 && work > -1 && auth < work,
    `auth at ${auth}, work at ${work} — this endpoint can read every message ` +
      `the workspace has ever exchanged with anybody`);

  chk("...and an unsigned request gets a 401",
    /if \(!userId\)[\s\S]{0,200}?status: 401/.test(entry));

  chk("a GET is refused", /req\.method !== "POST"[\s\S]{0,120}?status: 405/.test(entry));

  // The ceiling. Without it one press can page through a conversation
  // forever inside a function that gets ten seconds.
  chk("THE POINT: the page loop is bounded",
    /pages < MAX_PAGES/.test(entry),
    "a loop that only stops when Quo runs out of pages is a loop that times " +
      "out mid-import, and an import that timed out looks identical to one " +
      "that finished");

  chk("...and `more` is computed once, so the log cannot disagree with the answer",
    (src.match(/const more = Boolean\(token\);/g) || []).length === 1 &&
      !/more: Boolean\(token\)/.test(src),
    "written out at both sites, a change to one of them goes unnoticed — " +
      "which is exactly what a mutation run found");

  // The number never goes into the log in full.
  chk("the log masks the number",
    /participant\.slice\(-4\)/.test(entry) && !/who: participant,/.test(entry));

  // A failure must not be a blank 500.
  chk("THE POINT: a failure comes back with a sentence somebody can act on",
    /catch \(err\)[\s\S]{0,400}?error: err\?\.message/.test(entry),
    "a 500 shows whoever pressed the button a blank failure with the reason " +
      "in a log they cannot read");
}

console.log(bad === 0 ? "\nall ok — the backlog comes across, and nothing else does\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
