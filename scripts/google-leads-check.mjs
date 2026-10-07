// scripts/google-leads-check.mjs — does the Ads API let us read leads yet?
//
//   node scripts/google-leads-check.mjs <customer-id> <client-id> <client-secret> <refresh-token>
//
// One live query against the real account, run from your own machine, before
// anything is deployed or scheduled. It answers the only question that
// matters right now: is the access level we have enough to read Local
// Services leads?
//
// WHY THIS EXISTS RATHER THAN "DEPLOY AND SEE". Deploying first means the
// answer arrives as a failed scheduled invocation at seven minutes past some
// hour, with Google's reason buried in a Netlify log. The same request run
// here prints that reason on the spot, and costs nothing if it fails.
//
// It uses the SAME functions the scheduled poll uses — accessToken(),
// leadsQuery(), fetchPage() — so a green run here is evidence about the
// thing that will actually run, not about a lookalike written for the test.
//
// IT WRITES NOTHING. No database, no files. It reads and prints.
//
// Phone numbers are masked to their last four digits on the way out, because
// a terminal scrollback is not a place to leave a customer list.

import {
  accessToken,
  asGoogleTime,
  asRow,
  fetchPage,
  leadsQuery,
} from "../netlify/functions/google-leads.mjs";

const DAYS = Number(process.env.CHECK_DAYS) || 90;

function mask(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "…";
}

const [customerArg, idArg, secretArg, refreshArg] = process.argv.slice(2);

const customerId = String(customerArg || process.env.GOOGLE_ADS_CUSTOMER_ID || "")
  .replace(/\D/g, "");

// Set on process.env rather than passed, because accessToken() and
// fetchPage() read them there — the same way they will in Netlify. Faking the
// environment is the point: it tests the real code path.
if (idArg) process.env.GOOGLE_ADS_CLIENT_ID = idArg;
if (secretArg) process.env.GOOGLE_ADS_CLIENT_SECRET = secretArg;
if (refreshArg) process.env.GOOGLE_ADS_REFRESH_TOKEN = refreshArg;

const USAGE =
  "Usage: node scripts/google-leads-check.mjs <customer-id> <client-id> <client-secret> <refresh-token>\n\n" +
  "  customer-id     the Ads account number, e.g. 146-936-2727. Dashes are\n" +
  "                  fine; they get stripped, because the API rejects them\n" +
  "                  with a 404 that reads as 'no such account'.\n" +
  "  client-id       ends in .apps.googleusercontent.com\n" +
  "  client-secret   begins GOCSPX-\n" +
  "  refresh-token   begins 1//, from scripts/google-oauth.mjs\n";

if (!customerId) {
  console.error(USAGE);
  process.exit(1);
}

// A CUSTOMER ID IS TEN DIGITS. Checked, because the failure it catches is one
// argument out of place — and the symptom is a complaint about the LAST
// argument, which sends you looking at the refresh token.
//
// Pass the client id first and this script strips its letters and reports an
// "account" of 2158977961365223305: nineteen digits, obviously not an account
// number, and silently accepted by the first version of this file.
if (customerId.length !== 10) {
  console.error(
    `That is not an Ads customer id: ${customerId} (${customerId.length} digits, expected 10).\n\n` +
      (customerArg && /apps\.googleusercontent\.com|GOCSPX|^1\/\//.test(String(customerArg))
        ? "It looks like a client id, secret or refresh token — the arguments\n" +
          "are probably shifted. The ACCOUNT NUMBER comes first.\n\n"
        : "") +
      USAGE
  );
  process.exit(1);
}

const since = new Date(Date.now() - DAYS * 86400000);

console.log(`\nAccount   ${customerId}`);
console.log(`Since     ${asGoogleTime(since)}  (${DAYS} days)\n`);

let token;
try {
  token = await accessToken();
  console.log("✓ OAuth — Google issued an access token\n");
} catch (err) {
  console.error(`✗ OAuth — ${err.message}\n`);

  // The hint only when it fits. Printing the invalid_grant explanation under
  // a 403 that says something else entirely sends somebody to regenerate a
  // token that was never the problem — which is the shape of mistake that
  // has cost this project two evenings already.
  if (/invalid_grant/i.test(err.message)) {
    console.error(
      "  invalid_grant means the refresh token has been revoked, or that it\n" +
        "  was issued while the consent screen was still in Testing, which\n" +
        "  expires them after seven days. Re-run scripts/google-oauth.mjs.\n"
    );
  } else if (/not set in Netlify/i.test(err.message)) {
    // accessToken() is written for the scheduled function, where "not set in
    // Netlify" is the right advice. Here it is not — nobody running this at a
    // terminal is missing a Netlify variable, they are missing an argument.
    console.error(
      "  (That message comes from the deployed function's wording. Running\n" +
        "  here, it means an argument is missing.)\n\n" + USAGE
    );
  }
  process.exit(1);
}

let page;
try {
  page = await fetchPage({
    token,
    customerId,
    query: leadsQuery(asGoogleTime(since)),
  });
} catch (err) {
  console.error(`✗ Query — ${err.message}\n`);

  if (/not have access|developer token|access level|PERMISSION|DEVELOPER_TOKEN/i.test(err.message)) {
    console.error(
      "  That reads like an access-level problem rather than a bug.\n" +
        "  Explorer access covers reporting on production accounts, which is\n" +
        "  all this needs — if it is refused, Basic is the next tier up.\n"
    );
  }
  if (/CUSTOMER_NOT_FOUND|USER_PERMISSION_DENIED/i.test(err.message)) {
    console.error(
      "  Check the customer id, and whether the Google account that granted\n" +
        "  the refresh token can actually see that Ads account.\n"
    );
  }
  process.exit(1);
}

console.log(`✓ Query — Google answered with ${page.rows.length} lead(s)` +
  (page.next ? " and more pages available" : "") + "\n");

if (page.rows.length === 0) {
  console.log(
    "  No leads in that window. That is an answer, not a failure: the API\n" +
      "  works and the account simply has no Local Services leads yet. Try a\n" +
      "  longer window with CHECK_DAYS=365, or come back once ads are live.\n"
  );
  process.exit(0);
}

console.log("  What the CRM would store:\n");

for (const raw of page.rows.slice(0, 5)) {
  const row = asRow(raw.localServicesLead || raw.local_services_lead || raw);
  console.log(
    `    ${row.at ?? "(no date)"}  ${String(row.type ?? "?").padEnd(11)} ` +
      `${(row.name ?? "(no name)").padEnd(20)} ${mask(row.phone) ?? "(no number)"}` +
      `  charged=${"charged" in row ? row.charged : "not stated"}`
  );
}

if (page.rows.length > 5) console.log(`    …and ${page.rows.length - 5} more`);

console.log(
  "\n  If those look right, the access level is enough. Put the four values\n" +
    "  into Netlify, run db/google-leads.sql, and deploy.\n"
);
