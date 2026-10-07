// The poll that fetches Local Services leads: node verify/google-leads.mjs
//
// db/google-leads.sql decides what a lead MEANS — who it attaches to, whether
// it is new, what a missing name does — and verify/google-leads.sql proves
// that against a real Postgres. This file is the other half: does the poll
// read Google's shape correctly, ask for the right window, and fail loudly?
//
// THE DANGEROUS DIRECTION HERE IS A GAP. A poll that asks for the wrong
// window does not error; it returns fewer rows, and the leads that fall
// through are indistinguishable from leads that were never sent. Sky Blue is
// charged for those either way. Most of this file is about the window.
//
// Checks marked THE POINT are the ones this file exists for.

import {
  accessToken,
  asGoogleTime,
  asRow,
  describeLead,
  fetchPage,
  leadsQuery,
  windowStart,
} from "../netlify/functions/google-leads.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

console.log("\n-- reading Google's shape --\n");

{
  // The resource as GoogleAdsService returns it, in Google's camelCase JSON.
  const LEAD = {
    resourceName: "customers/1469362727/localServicesLeads/900123456",
    leadType: "PHONE_CALL",
    categoryId: "xcat:service_area_business_window_cleaning",
    serviceId: "window_cleaning_service",
    contactDetails: {
      phoneNumber: "+15415550144",
      consumerName: "Marion Webb",
      email: "marion@example.com",
    },
    leadStatus: "ENABLED",
    creationDateTime: "2026-10-06 15:30:00",
    leadCharged: true,
  };

  const row = asRow(LEAD);

  chk("THE POINT: the lead id comes from the resource name",
    row.id === "900123456",
    `id = ${row.id} — resource_name exists on every GAQL resource and cannot ` +
      `be renamed out from under this; a dedicated id field could be`);

  chk("the consumer's details are read",
    row.name === "Marion Webb" &&
      row.phone === "+15415550144" &&
      row.email === "marion@example.com",
    JSON.stringify({ name: row.name, phone: row.phone, email: row.email }));

  chk("the type, category and status come across",
    row.type === "PHONE_CALL" &&
      row.category === "xcat:service_area_business_window_cleaning" &&
      row.status === "ENABLED");

  chk("THE POINT: the time is Google's, passed through untouched",
    row.at === "2026-10-06 15:30:00",
    `at = ${row.at} — creation_date_time is in the ACCOUNT's timezone with no ` +
      `offset, and inventing one here shifts every lead by however wrong the ` +
      `guess is`);

  chk("whether Google charged for it is kept",
    row.charged === true);

  // snake_case, in case a client or a version returns it that way.
  const snake = asRow({
    resource_name: "customers/1/localServicesLeads/5",
    lead_type: "MESSAGE",
    contact_details: { phone_number: "+15415550101", consumer_name: "Dana" },
    creation_date_time: "2026-10-01 09:00:00",
    lead_charged: false,
  });
  chk("a snake_case payload is read too",
    snake.id === "5" && snake.name === "Dana" && snake.charged === false,
    JSON.stringify(snake));
}

console.log("\n-- what Google leaves out --\n");

{
  // A wiped lead: contact_details is null when lead_status is WIPED_OUT.
  const wiped = asRow({
    resourceName: "customers/1/localServicesLeads/7",
    leadType: "PHONE_CALL",
    leadStatus: "WIPED_OUT",
    creationDateTime: "2026-10-02 10:00:00",
    leadCharged: true,
  });

  chk("a wiped lead has no contact details and does not crash",
    wiped.id === "7" && wiped.name === null && wiped.phone === null,
    JSON.stringify(wiped));

  chk("...but still carries the charge",
    wiped.charged === true,
    "Google billed for it either way, and a cost with no record is a cost " +
      "nobody reconciles");

  // THE DISTINCTION THAT COSTS MONEY. "Not charged" and "not stated" are
  // different, and only one of them is a number somebody adds up.
  const unstated = asRow({
    resourceName: "customers/1/localServicesLeads/8",
    creationDateTime: "2026-10-02 10:00:00",
  });
  chk("THE POINT: a charge Google did not state is absent, not false",
    !("charged" in unstated),
    `charged = ${JSON.stringify(unstated.charged)} — false reads as "this ` +
      `lead was free"`);

  chk("a lead with no resource name has no id, rather than a wrong one",
    asRow({ leadType: "MESSAGE" }).id === null);
}

console.log("\n-- the sentence that lands on the timeline --\n");

{
  chk("a phone lead says so",
    describeLead({ leadType: "PHONE_CALL" }) === "Called through Google",
    describeLead({ leadType: "PHONE_CALL" }));

  chk("a message lead says so",
    describeLead({ leadType: "MESSAGE" }) === "Messaged through Google");

  chk("a booking says so",
    describeLead({ leadType: "BOOKING" }) === "Booked through Google");

  chk("THE POINT: the category id is made readable",
    describeLead({
      leadType: "PHONE_CALL",
      categoryId: "xcat:service_area_business_window_cleaning",
    }) === "Called through Google — window cleaning",
    describeLead({
      leadType: "PHONE_CALL",
      categoryId: "xcat:service_area_business_window_cleaning",
    }) + " — the raw id on a timeline is unreadable, and the tidy form is " +
      "still Google's own word rather than one invented here");

  chk("a type nobody has seen still produces a sentence",
    describeLead({ leadType: "SOMETHING_NEW" }) === "Google Local Services lead",
    describeLead({ leadType: "SOMETHING_NEW" }));

  chk("...and an empty lead does too",
    typeof describeLead({}) === "string" && describeLead({}).length > 0);
}

console.log("\n-- the window, which is where leads get lost --\n");

{
  const NOW = Date.parse("2026-10-07T12:00:00Z");

  // THE OVERLAP. Starting exactly at the newest lead steps over anything that
  // arrived late, and a lead that falls through the gap is indistinguishable
  // from one that was never sent — while still being charged for.
  const start = windowStart("2026-10-07T09:00:00Z", NOW);
  chk("THE POINT: the window starts BEFORE the newest lead we have",
    start.getTime() < Date.parse("2026-10-07T09:00:00Z"),
    `${start.toISOString()} — re-reading costs nothing because the database ` +
      `deduplicates on Google's id; missing a lead costs a customer`);

  chk("...by hours, not days",
    Date.parse("2026-10-07T09:00:00Z") - start.getTime() === 6 * 3600000,
    `${(Date.parse("2026-10-07T09:00:00Z") - start.getTime()) / 3600000} hours`);

  // THE FIRST RUN. An empty table must reach back, not forward.
  const first = windowStart(null, NOW);
  chk("THE POINT: with nothing stored it reaches back months",
    NOW - first.getTime() > 60 * 86400000,
    `${first.toISOString()} — a first run that starts at now() imports nothing ` +
      `and reports success, which is how an empty CRM looks like a working one`);

  chk("a high-water mark that is not a date is treated as no mark at all",
    windowStart("not a date", NOW).getTime() === first.getTime(),
    "NaN arithmetic produces an Invalid Date, and Google rejects the query " +
      "rather than returning everything — but the reason would be a date format");

  // Google's format, which is not ISO.
  chk("THE POINT: the time is formatted the way Google wants it",
    asGoogleTime("2026-10-07T09:30:05.123Z") === "2026-10-07 09:30:05",
    `${asGoogleTime("2026-10-07T09:30:05.123Z")} — an ISO string with a Z is ` +
      `rejected with a message about an invalid date, which reads as the date ` +
      `being wrong rather than the format`);

  chk("...with no milliseconds and no timezone marker",
    !/[TZ.]/.test(asGoogleTime(NOW)), asGoogleTime(NOW));
}

console.log("\n-- the query --\n");

{
  const q = leadsQuery("2026-10-01 00:00:00");

  // FIELD NAMES ARE NOT GUESSED. A name that does not exist fails the whole
  // query rather than returning null, so these are checked against the set
  // Google's own documented example uses.
  for (const field of [
    "local_services_lead.resource_name",
    "local_services_lead.lead_type",
    "local_services_lead.category_id",
    "local_services_lead.contact_details",
    "local_services_lead.lead_status",
    "local_services_lead.creation_date_time",
    "local_services_lead.lead_charged",
  ]) {
    chk(`the query selects ${field}`, q.includes(field));
  }

  chk("THE POINT: it is bounded by the window",
    /creation_date_time >= '2026-10-01 00:00:00'/.test(q),
    "an unbounded query re-reads every lead the account has ever had, every " +
      "hour, and pages until it times out halfway");

  chk("...and comes back oldest first",
    /ORDER BY local_services_lead\.creation_date_time ASC/.test(q),
    "newest-first plus a page limit means a busy hour loses the OLDEST leads, " +
      "which are the ones that have been waiting longest for a call");

  chk("contact_details is selected whole, not by subfield",
    !/contact_details\./.test(q),
    "Google's own example selects the message; naming subfields is a guess " +
      "that fails the entire query if one is renamed");
}

console.log("\n-- failing loudly --\n");

{
  const env = { ...process.env };
  for (const k of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]) {
    delete process.env[k];
  }

  let threw = "";
  try {
    await accessToken(async () => ({ ok: true, json: async () => ({}) }));
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a missing variable is named, one at a time",
    /GOOGLE_ADS_CLIENT_ID/.test(threw) &&
      /GOOGLE_ADS_REFRESH_TOKEN/.test(threw),
    `${threw} — "Google auth failed" sends somebody to the OAuth playground; ` +
      `this sends them to Netlify`);

  process.env.GOOGLE_ADS_CLIENT_ID = "id";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "refresh";

  threw = "";
  try {
    await accessToken(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant" }),
    }));
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a revoked refresh token says invalid_grant, in those words",
    /invalid_grant/.test(threw),
    `${threw} — a revoked token and a wrong secret are different afternoons`);

  threw = "";
  try {
    await accessToken(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  } catch (e) {
    threw = e.message;
  }
  chk("a 200 with no token is still a failure",
    /no access token/i.test(threw), threw);

  const token = await accessToken(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "tok-1" }),
  }));
  chk("a good exchange returns the token", token === "tok-1");

  for (const k of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

{
  // Google buries the useful sentence several levels down.
  let threw = "";
  try {
    await fetchPage({
      token: "t",
      customerId: "1",
      query: "SELECT 1",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Request contains an invalid argument.",
            details: [{ errors: [{ message: "Unrecognized field name 'local_services_lead.nope'." }] }],
          },
        }),
      }),
    });
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a rejected query reports Google's own sentence",
    /Unrecognized field name/.test(threw),
    `${threw} — the outer message is always "invalid argument", which names ` +
      `nothing; the diagnosis is three levels down`);

  // The headers that are conditional.
  const seen = [];
  const capture = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ results: [], nextPageToken: null }) };
  };

  const had = {
    dev: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    login: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  };
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  await fetchPage({ token: "t", customerId: "1469362727", query: "Q", fetchImpl: capture });
  chk("the account id is in the path",
    seen[0].url.includes("/customers/1469362727/googleAds:search"), seen[0].url);
  chk("the token is sent as a bearer",
    seen[0].headers.Authorization === "Bearer t");
  chk("THE POINT: no developer token is sent when none is set",
    !("developer-token" in seen[0].headers),
    "Google stopped using it as the permission carrier on 10 Sep 2026; an " +
      "empty one would be worse than none");
  chk("...and no login-customer-id either",
    !("login-customer-id" in seen[0].headers));

  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev";
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "1234567890";
  seen.length = 0;
  await fetchPage({ token: "t", customerId: "1", query: "Q", fetchImpl: capture });
  chk("both are sent when they are set",
    seen[0].headers["developer-token"] === "dev" &&
      seen[0].headers["login-customer-id"] === "1234567890");

  seen.length = 0;
  await fetchPage({ token: "t", customerId: "1", query: "Q", pageToken: "pg-2", fetchImpl: capture });
  chk("a continuation carries the page token", seen[0].body.pageToken === "pg-2");

  const page = await fetchPage({
    token: "t",
    customerId: "1",
    query: "Q",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ localServicesLead: { resourceName: "a/b/1" } }], nextPageToken: "n" }),
    }),
  });
  chk("rows and the next token come back", page.rows.length === 1 && page.next === "n");

  const empty = await fetchPage({
    token: "t", customerId: "1", query: "Q",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  chk("an empty answer is empty, not a crash",
    empty.rows.length === 0 && empty.next === null);

  for (const [k, v] of [["GOOGLE_ADS_DEVELOPER_TOKEN", had.dev], ["GOOGLE_ADS_LOGIN_CUSTOMER_ID", had.login]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log("\n-- a whole run, end to end --\n");

// A mutant that logged only when something was imported survived every
// lexical check here: the phrase was still in the file, inside an `if`. The
// property is "every run leaves a line, including the quiet ones", and the
// only way to check it is to run a quiet one.
{
  const { build } = await import("esbuild");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "glead-"));
  const out = "verify/.google-leads-bundle.mjs";

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
            contents: `export { default as handler } from "${process.cwd()}/netlify/functions/google-leads.mjs";`,
            loader: "js",
            resolveDir: process.cwd(),
          }));
          b.onResolve({ filter: /db\.mjs$/ }, (a) => ({ path: a.path, namespace: "db" }));
          b.onLoad({ filter: /.*/, namespace: "db" }, () => ({
            contents:
              "export async function rpc(fn, args) {" +
              "  (globalThis.__rpc ||= []).push({ fn, args });" +
              "  if (fn === 'latest_google_lead_at') return globalThis.__latest ?? null;" +
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

  const { handler } = await import("./.google-leads-bundle.mjs");

  const env = { ...process.env };
  process.env.GOOGLE_ADS_CLIENT_ID = "id";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "secret";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = "refresh";
  process.env.GOOGLE_ADS_CUSTOMER_ID = "146-936-2727";
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

  const realFetch = globalThis.fetch;
  const realLog = console.log;

  const serve = (pagesAvailable) => {
    const calls = [];
    const impl = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
      }
      const body = JSON.parse(opts.body);
      const n = body.pageToken ? Number(body.pageToken) : 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: pagesAvailable ? 2 : 0 }, (_, i) => ({
            localServicesLead: {
              resourceName: `customers/1/localServicesLeads/${n}${i}`,
              leadType: "PHONE_CALL",
              contactDetails: { phoneNumber: "+1541555010" + i, consumerName: "A" },
              creationDateTime: "2026-10-06 09:00:00",
              leadCharged: true,
            },
          })),
          nextPageToken: n < pagesAvailable ? String(n + 1) : null,
        }),
      };
    };
    return { impl, calls };
  };

  const post = () =>
    new Request("https://crm.skybluecleaningco.com/.netlify/functions/google-leads", {
      method: "POST",
    });

  // A QUIET RUN: Google has nothing new.
  const said = [];
  globalThis.__rpc = [];
  globalThis.__latest = "2026-10-07T09:00:00Z";
  let served = serve(0);
  globalThis.fetch = served.impl;
  console.log = (...a) => said.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  let res = await handler(post());
  let data = await res.json();
  console.log = realLog;

  chk("a run with nothing new still succeeds",
    data.ok === true && data.scanned === 0 && data.imported === 0,
    JSON.stringify(data));

  chk("THE POINT: ...and still leaves a line in the log",
    said.some((l) => /\[google-leads\] ran/.test(l)),
    said.join(" | ") || "(nothing logged)" +
      " — an empty log and a run that never happened look identical");

  chk("...which says where it read from",
    said.some((l) => /the newest lead we had/.test(l)), said.join(" | "));

  // The account id reached the URL without its dashes.
  chk("THE POINT: the dashes are stripped from the customer id",
    served.calls.some((c) => c.url.includes("/customers/1469362727/")),
    served.calls.map((c) => c.url).join(", ") +
      " — the API answers a dashed id with a 404 that reads as 'no such account'");

  // A BUSY RUN across pages.
  said.length = 0;
  globalThis.__rpc = [];
  globalThis.__latest = null;
  served = serve(3);
  globalThis.fetch = served.impl;
  console.log = () => {};
  res = await handler(post());
  data = await res.json();
  console.log = realLog;

  chk("every page is read and handed over",
    data.scanned === 6 && data.imported === 6,
    JSON.stringify(data));

  chk("...through the one import function",
    globalThis.__rpc.filter((c) => c.fn === "record_google_leads").length === 3,
    globalThis.__rpc.map((c) => c.fn).join(", "));

  chk("THE POINT: the first run asks the database where to start, not a cursor",
    globalThis.__rpc[0]?.fn === "latest_google_lead_at",
    "a stored cursor is a second fact that can disagree with the data, and " +
      "the disagreement is silent");

  // The ceiling.
  said.length = 0;
  globalThis.__rpc = [];
  served = serve(9);
  globalThis.fetch = served.impl;
  console.log = () => {};
  res = await handler(post());
  data = await res.json();
  console.log = realLog;

  chk("THE POINT: a long first run stops at the ceiling and says there is more",
    data.more === true && data.pages === undefined && data.scanned === 10,
    JSON.stringify(data) + " — the next run picks up from the high-water mark");

  // A GET.
  chk("a GET is refused",
    (await handler(new Request("https://crm.skybluecleaningco.com/x"))).status === 405);

  // A failure must throw, not resolve.
  globalThis.fetch = async (url) =>
    String(url).includes("oauth2")
      ? { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }
      : { ok: true, status: 200, json: async () => ({}) };
  const realError = console.error;
  console.error = () => {};
  console.log = () => {};
  let threw = "";
  try {
    await handler(post());
  } catch (e) {
    threw = e.message;
  }
  console.log = realLog;
  console.error = realError;

  chk("THE POINT: a bad refresh token fails the invocation, loudly",
    /invalid_grant/.test(threw),
    `${threw || "(did not throw)"} — a 200 with an error inside shows in ` +
      `Netlify as a successful run that found nothing, forever`);

  globalThis.fetch = realFetch;
  delete globalThis.__rpc;
  delete globalThis.__latest;
  for (const k of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
                   "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

console.log("\n-- the rules that must not break --\n");

{
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync("netlify/functions/google-leads.mjs", "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

  // THE ENDPOINT HOLDS NO POLICY. Everything about what a lead means lives in
  // db/google-leads.sql, tested against a real Postgres. A second opinion here
  // would be a second way for a lead to reach the board with none of those
  // rules attached.
  chk("THE POINT: the poll does not decide who a lead belongs to",
    !/sb_contact_for_phone|insert into|leads\b.*=/.test(src),
    "that judgement is record_google_lead()'s, next to the data");

  chk("...and writes only through the one import function",
    /rpc\(\s*"record_google_leads"/.test(src) &&
      (src.match(/rpc\(\s*"/g) || []).length === 2,
    "one to read the high-water mark, one to write — nothing else");

  const entry = src.slice(src.indexOf("export default async (req)"));

  chk("THE POINT: the loop is bounded",
    /pages < MAX_PAGES/.test(entry),
    "a loop that stops only when Google runs out of pages times out mid-run, " +
      "and a run that timed out looks exactly like one that finished");

  chk("a failure is thrown, so Netlify shows a failed invocation",
    /throw err;/.test(entry),
    "a 200 with an error inside it shows as a successful run that found " +
      "nothing, forever");

  chk("THE POINT: every run leaves a line, including the quiet ones",
    /console\.log\("\[google-leads\] ran"/.test(entry),
    "an empty log and a run that never happened look identical — a mistake " +
      "this codebase has now made three times");

  chk("the schedule is declared and no public path is",
    /schedule:/.test(src) && !/path:\s*"/.test(src),
    "this writes to customer records; nothing outside the scheduler should " +
      "be able to start it");

  chk("the customer id is stripped to digits",
    /replace\(\/\\D\/g, ""\)/.test(entry),
    "Google shows it as 146-936-2727 and the API rejects the dashes with a " +
      "404 that reads as 'no such account'");

  chk("the API version is overridable",
    /GOOGLE_ADS_API_VERSION/.test(src),
    "Google retires versions roughly yearly, and a hardcoded one is a time " +
      "bomb that goes off on a Saturday");
}

console.log(bad === 0 ? "\nall ok — the leads Google charges for land here too\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
