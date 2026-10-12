// Telling Jordan and Hayden a lead came in:
//   node verify/lead-alerts.mjs
//
// THE BUG THIS EXISTS FOR. A form was submitted on 12 October, the lead row
// landed in the CRM, and nobody was told for two hours. The notification was
// a POST from the customer's browser to api.web3forms.com and it never
// arrived — that domain is on several ad-blocker lists, and Web3Forms has no
// record of the request, which is what a blocked request looks like from the
// far end.
//
// The alert now goes out from the CRM's own one-minute sweep, reading a row
// that is already committed.
//
// WHAT CAN STILL GO WRONG, and what most of this file is about:
//
//   THE ALERT LANDS ON THE CUSTOMER'S THREAD. Passing a leadId to sendSms
//   would file an internal "new lead from the website" into the text
//   conversation with the customer — and worse, it would count as an
//   outbound text on that lead, which is exactly what sms_due_lead_acks
//   uses to decide the customer has already been answered. One argument,
//   two silent failures.
//
//   IT CLAIMS WITH NOWHERE TO SEND. If ALERT_SMS_TO is unset and the sweep
//   claims first and checks second, every lead is marked alerted while the
//   setting is missing and none of them is ever alerted again.
//
// Checks marked THE POINT are the ones this file exists for.

import { alertNumbers, alertText } from "../netlify/lib/leadAlerts.mjs";
import { newLeadNotification } from "../netlify/lib/notify.mjs";
import { readFileSync } from "node:fs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

console.log("\n-- who gets told --\n");

{
  chk("two numbers, comma separated",
    alertNumbers("+15415550101,+15415550202").length === 2);

  chk("spaces and semicolons work too",
    alertNumbers("+15415550101; +15415550202").length === 2,
    "this is typed into a Netlify settings box by hand at some point");

  chk("THE POINT: a number typed without the country code still works",
    alertNumbers("541-555-0101")[0] === "+15415550101",
    "toE164, the same normaliser the rest of the SMS code uses. A plain " +
      "ten-digit number is how a person writes their own phone number");

  chk("THE POINT: one bad entry does not cost the other brother his text",
    alertNumbers("+15415550101, not-a-phone").length === 1,
    "a trailing comma or a typo must not take the whole alert down — the " +
      "failure mode of 'strict' here is nobody being told, which is the " +
      "thing being fixed");

  chk("duplicates collapse",
    alertNumbers("+15415550101,541-555-0101").length === 1,
    "the same number written two ways is one phone, and two identical " +
      "texts is how somebody learns to ignore the first");

  chk("THE POINT: unset means nobody, not everybody",
    alertNumbers("").length === 0 && alertNumbers(undefined).length === 0 &&
      alertNumbers(null).length === 0);

  chk("it is read per call, not once at import",
    /alertNumbers\(raw = process\.env\.ALERT_SMS_TO\)/.test(
      readFileSync("netlify/lib/leadAlerts.mjs", "utf8")
    ),
    "Netlify reuses a warm instance for minutes, so a value captured at " +
      "module load keeps its old setting after somebody changes it in the " +
      "dashboard and wonders why nothing happened");
}

console.log("\n-- what the text says --\n");

{
  const full = alertText({
    out_name: "Kristina Hale",
    out_phone: "541-555-0101",
    out_email: "k@example.com",
    out_address: "123 NW 9th St, Corvallis",
    out_service: "windows",
    out_source: "website",
  });
  const lines = full.split("\n");

  chk("THE POINT: the name is on the first line",
    lines[0] === "New lead from the website: Kristina Hale",
    "a lock screen shows two lines. The first one has to answer 'who' and " +
      "'from where' or the notification has to be opened to be useful, " +
      "which costs the minute it was trying to save");

  chk("THE POINT: the number is on the second, on its own",
    lines[1] === "541-555-0101",
    "undecorated and alone so a phone linkifies it — the action this text " +
      "exists to prompt is a call, and it should be one tap from the " +
      "notification");

  chk("the details come third",
    lines[2] === "window cleaning · 123 NW 9th St, Corvallis");

  chk("the source reads as English, not as a database value",
    alertText({ out_source: "google_lsa", out_name: "Dale" })
      .startsWith("New lead from Google Local Services: Dale"),
    "'google_lsa' in a text message is a column name somebody has to " +
      "translate at six in the morning");

  chk("an unknown source is printed rather than swallowed",
    alertText({ out_source: "yelp", out_name: "Dale" })
      .startsWith("New lead from yelp: Dale"),
    "a source added to the CRM before it is added to the map should look " +
      "slightly raw, not disappear");

  chk("no name is 'Someone', not blank",
    alertText({ out_source: "website", out_phone: "541-555-0101" })
      .startsWith("New lead from the website: Someone"),
    "'New lead from the website: ' with nothing after it reads as a bug");

  chk("THE POINT: no phone falls back to the email",
    alertText({ out_name: "Dale", out_email: "d@example.com" }).split("\n")[1]
      === "d@example.com",
    "an enquiry with only an email is the one easiest to lose track of; a " +
      "text with no way to reach them is no use at all");

  chk("missing details are left out rather than printed empty",
    alertText({ out_name: "Dale", out_phone: "541-555-0101" }).split("\n").length === 2,
    "no third line, rather than a line with a lone separator on it");

  chk("...and a service with no address still gets its line",
    alertText({ out_name: "Dale", out_phone: "x", out_service: "gutters" })
      .split("\n")[2] === "gutter cleaning");

  chk("there is no link in it",
    !/http/.test(full),
    "a link opens a browser, waits for the app, and asks for a login. The " +
      "useful action is already in the message");
}

console.log("\n-- what the email says --\n");

// The text is the interruption and the email is the record, so the two are
// checked for different things: the text for what fits a lock screen, this
// for what would be lost if it were only a text.

{
  const full = newLeadNotification({
    name: "Kristina Hale",
    phone: "541-555-0101",
    email: "k@example.com",
    address: "123 NW 9th St, Corvallis",
    service: "windows",
    source: "website",
    propertyType: "residential",
    stories: "two",
    windows: 20,
    estimate: 400,
    notes: "Gutters look rough too, big dog in the yard",
    leadId: "lead-1",
  });

  chk("THE POINT: the subject is filterable",
    full.subject === "New lead — Kristina Hale (website)",
    "got " + JSON.stringify(full.subject) + ". The source in the subject is " +
      "what a mailbox rule sorts on, and the article comes off — " +
      "'(the website)' reads as a typo in a list of subject lines");

  chk("...and an unknown source is still printed",
    newLeadNotification({ name: "D", source: "yelp" }).subject.endsWith("(yelp)"));

  chk("THE POINT: it carries what the text cannot",
    /Gutters look rough too/.test(full.html) &&
      /What they said/.test(full.html),
    "'big dog in the yard' is one of the two most useful sentences in any " +
      "enquiry and there is nowhere for it on a lock screen. If it is not " +
      "here it is nowhere");

  chk("...and the rest of the enquiry",
    /123 NW 9th St/.test(full.html) &&
      /Two story/.test(full.html) &&
      />20</.test(full.html) &&
      /\$400/.test(full.html),
    "address, stories, windows, estimate — the record half of the job");

  chk("the phone is tappable and the email is mailto",
    /href="tel:\+?1?5415550101"/.test(full.html) && /href="mailto:k@example.com"/.test(full.html),
    "read on a phone as often as on a laptop");

  chk("there is a link to the record",
    /\/leads\/lead-1/.test(full.html),
    "unlike the text, which deliberately has none — an email is already " +
      "open on a machine with a browser");

  // The three internal emails land in one inbox and the colour is what says
  // which is which at a glance.
  chk("THE POINT: it is not the same colour as the quote emails",
    /#b45309/.test(full.html) && !/#2563eb;padding:22px/.test(full.html),
    "blue is 'quote sent', green is 'they said yes'. A new lead is the one " +
      "that is neither done nor won");

  const bare = newLeadNotification({ source: "website", leadId: "x" });
  chk("a nameless enquiry does not render as undefined",
    /Someone/.test(bare.html) && !/undefined/.test(bare.html));

  chk("empty fields produce no empty rows",
    !/Their estimate/.test(bare.html) && !/What they said/.test(bare.html),
    "row() returns nothing for a falsy value — a table of blank labels is " +
      "harder to read than a short one");

  chk("THE POINT: an estimate of zero is treated as not filled in",
    !/Their estimate/.test(
      newLeadNotification({ name: "D", source: "website", estimate: 0 }).html
    ),
    "the forms post 0 when nobody touched it, and 'Their estimate: $0' " +
      "reads as a quote for nothing");
}

console.log("\n-- the send --\n");

{
  const src = strip(readFileSync("netlify/lib/leadAlerts.mjs", "utf8"));

  // SCOPED TO THE sendSms CALL, not the file. The EMAIL does carry a lead
  // id — that is what puts an "Open in the CRM" button on it — so a blanket
  // check for the string fails on correct code, which is how a check gets
  // deleted rather than fixed.
  const smsStart = src.indexOf("await sendSms({");
  const smsCall = src.slice(smsStart, src.indexOf("});", smsStart));
  chk("THE POINT: no leadId is passed to sendSms",
    smsCall.length > 0 && !/leadId/.test(smsCall),
    "passing one files the internal alert onto the CUSTOMER's text thread, " +
      "AND disqualifies that lead from its own acknowledgment, because " +
      "sms_due_lead_acks treats any outbound text on a lead as somebody " +
      "having already replied");

  // BOTH PRESENT, THEN ORDERED. indexOf returns -1 for a string that is not
  // there, and -1 is less than everything — so the ordering test alone
  // passes with flying colours the moment somebody deletes the guard it is
  // checking the position of. This mutant survived the first run of this
  // file.
  chk("THE POINT: the email goes out too",
    /newLeadNotification\(/.test(src) && /await notify\(/.test(src));

  chk("THE POINT: one channel failing does not cost the other",
    src.indexOf("if (mailing)") < src.indexOf("for (const number of to)") &&
      (src.match(/catch \(err\)/g) || []).length >= 2,
    "separate try blocks. A bad phone number costing the email would be " +
      "the Web3Forms mistake in reverse");

  chk("THE POINT: having only ONE channel configured still sends",
    /if \(to\.length === 0 && !mailing\)/.test(src),
    "`to.length === 0` alone would claim and discard every lead for " +
      "somebody who turned on the email and not the texts");

  chk("THE POINT: nothing is claimed when there is nowhere to send",
    src.includes("if (to.length === 0 && !mailing)") &&
      src.includes("sb_claim_lead_alerts") &&
      src.indexOf("if (to.length === 0 && !mailing)") < src.indexOf("sb_claim_lead_alerts"),
    "claiming first marks every lead alerted while ALERT_SMS_TO is unset, " +
      "and none of them is ever alerted again once it is set");

  chk("quiet hours are bypassed",
    /force: true/.test(src),
    "quiet hours stop the CRM texting a CUSTOMER at 11pm. These two asked " +
      "to be woken up");

  chk("one bad number does not abandon the batch",
    /catch \(err\)/.test(src) && /out\.problems\.push/.test(src));

  chk("a claim that throws is reported, not swallowed",
    /stage: "claim"/.test(src),
    "rpc() throws on a missing function, which is what 'db/lead-alerts.sql " +
      "has not been run yet' looks like");

  chk("THE POINT: runLeadAlerts never throws",
    !/^\s*throw /m.test(src),
    "it runs inside the acknowledgment sweep. A failure to tell Jordan " +
      "must not stop the customer being told we got their message");
}

console.log("\n-- and it is RUN, not just read --\n");

// EVERY CHECK ABOVE EITHER CALLS A PURE FUNCTION OR GREPS A FILE, and a
// mutation run showed exactly what the greps are worth: turning the whole
// email block off (`if (false)`), dropping `notes` from the arguments, and
// dropping `leadId` from them all passed. `newLeadNotification` was still
// perfect — nothing was calling it with the right things.
//
// So runLeadAlerts is run for real against stubbed edges. The only things
// replaced are the three boundaries — the database, Quo, Resend. The
// function under test, and the email builder it calls, are the shipped ones.

{
  const { writeFileSync, rmSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");

  const DIR = "netlify/lib/";
  const TMP = DIR + "__leadAlerts.undertest.mjs";
  const DB = DIR + "__db.stub.mjs";
  const SMS = DIR + "__sms.stub.mjs";

  // Only the rows this test drives. Written out rather than hidden, because
  // a stub whose shape has drifted from sb_claim_lead_alerts is a test that
  // passes about nothing.
  writeFileSync(DB, `
    export let claimed = [];
    export function __claim(rows) { claimed = rows; }
    export async function rpc(fn) {
      if (fn !== "sb_claim_lead_alerts") throw new Error("unexpected rpc " + fn);
      const out = claimed;
      claimed = [];
      return out;
    }
  `);

  writeFileSync(SMS, `
    export let texts = [];
    export function __reset() { texts = []; }
    export async function sendSms(args) { texts.push(args); return { ok: true }; }
    export function toE164(p) {
      const d = String(p || "").replace(/\\D/g, "");
      if (d.length === 10) return "+1" + d;
      if (d.length === 11 && d[0] === "1") return "+" + d;
      return null;
    }
  `);

  const rewritten = readFileSync("netlify/lib/leadAlerts.mjs", "utf8")
    .replace('from "../lib/db.mjs"', 'from "./__db.stub.mjs"')
    .replace('from "./sms.mjs"', 'from "./__sms.stub.mjs"')
    // notify.mjs is NOT stubbed — it is the thing being checked. Only its
    // one outbound call is, by making notifyConfigured() true and capturing
    // what notify() was handed.
    .replace(
      'import { newLeadNotification, notify, notifyConfigured } from "./notify.mjs";',
      'import { newLeadNotification } from "./notify.mjs";\n' +
        "export const mails = [];\n" +
        "const notifyConfigured = () => true;\n" +
        "const notify = async (m) => { mails.push(m); return { ok: true }; };"
    );

  writeFileSync(
    TMP,
    rewritten + '\nexport { __claim } from "./__db.stub.mjs";\n' +
      'export { texts, __reset } from "./__sms.stub.mjs";\n'
  );

  try {
    const mod = await import(pathToFileURL(TMP).href);
    process.env.ALERT_SMS_TO = "541-555-1111, 541-555-2222";

    mod.__claim([
      {
        out_lead_id: "lead-9",
        out_name: "Kristina Hale",
        out_phone: "541-555-0101",
        out_email: "k@example.com",
        out_address: "123 NW 9th St, Corvallis",
        out_service: "windows",
        out_source: "website",
        out_property_type: "residential",
        out_stories: "two",
        out_windows: 20,
        out_estimate: 400,
        out_notes: "Gutters look rough too, big dog in the yard",
      },
    ]);

    const r = await mod.runLeadAlerts({ limit: 10 });

    chk("THE POINT: one lead, two texts and one email",
      r.texted === 2 && r.emailed === 1 && r.problems.length === 0,
      "got " + JSON.stringify(r) + " — two numbers is two messages, and the " +
        "inbox is one record");

    chk("THE POINT: the email actually goes out",
      mod.mails.length === 1,
      "`if (false)` around the whole email block passed every source check " +
        "in this file");

    const mail = mod.mails[0];
    chk("...with the subject a mailbox rule can sort on",
      mail.subject === "New lead — Kristina Hale (website)",
      JSON.stringify(mail.subject));

    chk("THE POINT: it is built from the LEAD, not from nothing",
      /Gutters look rough too/.test(mail.html) &&
        /123 NW 9th St/.test(mail.html) &&
        /Two story/.test(mail.html) &&
        /\$400/.test(mail.html),
      "dropping `notes:` from the arguments left newLeadNotification " +
        "perfect and the email empty — which is what a unit test of a pure " +
        "function cannot see");

    chk("...including the link to the record",
      /\/leads\/lead-9/.test(mail.html),
      "dropping `leadId:` removes the 'Open in the CRM' button and nothing " +
        "else changes");

    chk("THE POINT: the texts carry no leadId",
      mod.texts.length === 2 &&
        mod.texts.every((t) => t.leadId === undefined) &&
        mod.texts.every((t) => t.force === true),
      "checked on the real call rather than in the source: this is what " +
        "keeps an internal alert off the customer's thread");

    chk("...and go to both numbers, normalised",
      mod.texts.map((t) => t.phone).sort().join() === "+15415551111,+15415552222");

    chk("...with the lock-screen body, not the email body",
      mod.texts[0].body.startsWith("New lead from the website: Kristina Hale") &&
        !/Gutters look rough/.test(mod.texts[0].body),
      "the two channels are different shapes on purpose — a text carrying " +
        "the notes field is a text nobody can read at a glance");

    // ONE CHANNEL MISSING, THE OTHER UNAFFECTED.
    mod.__reset();
    mod.mails.length = 0;
    process.env.ALERT_SMS_TO = "";
    mod.__claim([{ out_lead_id: "lead-10", out_name: "Dale", out_source: "google_lsa" }]);
    const emailOnly = await mod.runLeadAlerts({ limit: 10 });

    chk("THE POINT: no numbers configured still sends the email",
      emailOnly.emailed === 1 && emailOnly.texted === 0 && mod.mails.length === 1,
      "got " + JSON.stringify(emailOnly) + " — the guard checks BOTH " +
        "channels, so turning on one does not silently claim and discard " +
        "every lead");
  } finally {
    rmSync(TMP, { force: true });
    rmSync(DB, { force: true });
    rmSync(SMS, { force: true });
  }
}

console.log("\n-- it is wired into the sweep --\n");

{
  const src = strip(readFileSync("netlify/functions/ack-leads.mjs", "utf8"));

  chk("the sweep calls it",
    /runLeadAlerts\(\{ limit: \d+ \}\)/.test(src));

  // THE CALL, NOT THE IMPORT. The first version of this compared against
  // indexOf("runLeadAlerts"), which finds the import statement at the top
  // of the file and is therefore always before everything. A check that
  // cannot fail is worse than no check, because it reads as covered.
  chk("THE POINT: after the customer's acknowledgment, not before",
    src.includes("sms_due_lead_acks") &&
      src.includes("await runLeadAlerts(") &&
      src.indexOf("sms_due_lead_acks") < src.indexOf("await runLeadAlerts("),
    "if one minute's run only gets through part of its work, the promise " +
      "made on the form is the half that should already have happened");

  chk("it logs only when there is something to say",
    /if \(alerts\.texted \|\| alerts\.emailed \|\| alerts\.skipped \|\| alerts\.problems\.length\)/.test(src),
    "this runs 1,440 times a day and a line every time buries the handful " +
      "that matter");

  chk("the sweep still runs every minute",
    /schedule: "\* \* \* \* \*"/.test(src));
}

console.log(bad === 0
  ? "\nall ok — told within the minute, on the CRM's own schedule\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
