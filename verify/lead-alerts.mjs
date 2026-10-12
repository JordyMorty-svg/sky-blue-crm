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

console.log("\n-- the send --\n");

{
  const src = strip(readFileSync("netlify/lib/leadAlerts.mjs", "utf8"));

  chk("THE POINT: no leadId is passed to sendSms",
    !/leadId/.test(src),
    "passing one files the internal alert onto the CUSTOMER's text thread, " +
      "AND disqualifies that lead from its own acknowledgment, because " +
      "sms_due_lead_acks treats any outbound text on a lead as somebody " +
      "having already replied");

  // BOTH PRESENT, THEN ORDERED. indexOf returns -1 for a string that is not
  // there, and -1 is less than everything — so the ordering test alone
  // passes with flying colours the moment somebody deletes the guard it is
  // checking the position of. This mutant survived the first run of this
  // file.
  chk("THE POINT: nothing is claimed when there is nowhere to send",
    src.includes("if (to.length === 0)") &&
      src.includes("sb_claim_lead_alerts") &&
      src.indexOf("if (to.length === 0)") < src.indexOf("sb_claim_lead_alerts"),
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
    /if \(alerts\.texted \|\| alerts\.skipped \|\| alerts\.problems\.length\)/.test(src),
    "this runs 1,440 times a day and a line every time buries the handful " +
      "that matter");

  chk("the sweep still runs every minute",
    /schedule: "\* \* \* \* \*"/.test(src));
}

console.log(bad === 0
  ? "\nall ok — told within the minute, on the CRM's own schedule\n"
  : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
