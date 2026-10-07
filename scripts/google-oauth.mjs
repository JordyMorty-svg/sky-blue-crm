// scripts/google-oauth.mjs — get a refresh token for the Google Ads API
//
//   node scripts/google-oauth.mjs <client-id> <client-secret>
//
// Run it on your own machine. It opens a browser, you approve, and it prints
// a refresh token TO YOUR TERMINAL. That value goes into Netlify as
// GOOGLE_ADS_REFRESH_TOKEN and nowhere else — not into this repo, not into a
// chat window, not into a note. It is a standing key to the Ads account.
//
// WHY A SCRIPT AND NOT THE OAUTH PLAYGROUND. The playground works, but it
// means pasting the client secret into a Google-hosted page and trusting the
// "use your own credentials" checkbox, and it needs an extra redirect URI
// registered that then sits in the console forever. This runs locally,
// touches nothing but your own machine, and can be re-run in a year when
// nobody remembers how this was done.
//
// ---------------------------------------------------------------------------
// BEFORE RUNNING THIS — the two settings that decide whether it still works
// next week.
// ---------------------------------------------------------------------------
//
// 1. PUBLISHING STATUS MUST NOT BE "TESTING".
//
//    Google expires every refresh token issued by an app in Testing after
//    exactly SEVEN DAYS. The hourly poll would run fine all week and then
//    start failing with `invalid_grant`, which reads like somebody revoked
//    access rather than like a dropdown.
//
//    APIs & Services → OAuth consent screen → PUBLISH APP.
//
//    If the Google account is on a Workspace domain, set User type to
//    INTERNAL instead: no verification, no warning screen, no expiry.
//
// 2. CLIENT TYPE: DESKTOP APP.
//
//    A Desktop client may redirect to http://localhost on any port, so the
//    loopback below needs no redirect URI registered. A Web application
//    client refuses unless the exact port is registered first, and the error
//    says `redirect_uri_mismatch` without saying which one it wanted.
//
// An unverified published app shows a "Google hasn't verified this app"
// screen. Click Advanced → Go to (unsafe). It is your own app asking for
// access to your own Ads account; the warning is about apps asking OTHER
// people for access.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// The one scope the Ads API needs. Narrow on purpose: this token can read
// every lead and every dollar of spend in the account, and there is no reason
// for it to also carry Drive or Gmail.
export const SCOPE = "https://www.googleapis.com/auth/adwords";

const PORT = 8787;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;

/**
 * The consent URL.
 *
 * TWO PARAMETERS ARE LOAD-BEARING and both fail silently when missing.
 *
 *   access_type=offline — without it Google returns an access token and NO
 *     refresh token. The exchange succeeds, the script prints nothing useful,
 *     and it looks like the script is broken.
 *
 *   prompt=consent — without it, a second run for an account that has already
 *     approved returns no refresh token either, because Google only issues
 *     one on first consent. That is the version that wastes an afternoon:
 *     it works once, and never again when you need to redo it.
 */
export function authUrl(clientId, redirect = REDIRECT, state = "") {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Swap the one-time code for tokens.
 */
export async function exchange({ code, clientId, clientSecret, redirect = REDIRECT, fetchImpl = fetch }) {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }).toString(),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Google refused the code (${res.status}${body?.error ? `: ${body.error}` : ""})` +
        (body?.error_description ? ` — ${body.error_description}` : "")
    );
  }

  if (!body.refresh_token) {
    // The failure this script exists to make legible. Google returned a
    // perfectly good access token and no refresh token, which means consent
    // was remembered from last time.
    throw new Error(
      "Google returned no refresh token. That happens when this account has " +
        "approved before and the consent screen was skipped. Revoke it at " +
        "https://myaccount.google.com/permissions and run this again, or " +
        "check that prompt=consent is still on the URL above."
    );
  }

  return body;
}

// --- the bit that runs ------------------------------------------------------

// RUN DIRECTLY, OR IMPORTED BY A TEST?
//
// pathToFileURL(), not string concatenation. The first version built the URL
// by hand — `file://${process.argv[1]}` — which is correct on Linux and wrong
// on Windows, where argv[1] is `C:\Users\...` and the real module URL is
// `file:///C:/Users/...`. Different separators, different number of slashes,
// no match.
//
// The failure was silent and total: the whole block below is inside this
// check, so running the script on Windows printed NOTHING — not the consent
// URL, not even the usage message when arguments were missing. It looked like
// Node had done nothing at all, which is exactly what it had done.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [clientId, clientSecret] = process.argv.slice(2);

  if (!clientId || !clientSecret) {
    console.error(
      "Usage: node scripts/google-oauth.mjs <client-id> <client-secret>\n\n" +
        "Both come from Google Cloud → APIs & Services → Credentials →\n" +
        "the OAuth 2.0 Client ID of type Desktop app."
    );
    process.exit(1);
  }

  // A random value echoed back by Google, so a stray request to the loopback
  // port cannot hand this script somebody else's code.
  const state = Math.random().toString(36).slice(2);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end();
      return;
    }

    const reply = (text) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
    };

    if (url.searchParams.get("state") !== state) {
      reply("That request did not come from this script. Nothing was done.");
      return;
    }

    const denied = url.searchParams.get("error");
    if (denied) {
      reply(`Google said: ${denied}. Nothing was done.`);
      console.error(`\nDeclined: ${denied}`);
      server.close();
      process.exitCode = 1;
      return;
    }

    try {
      const tokens = await exchange({
        code: url.searchParams.get("code"),
        clientId,
        clientSecret,
      });

      reply("Done. The refresh token is in your terminal — close this tab.");

      console.log("\n──────────────────────────────────────────────────────────");
      console.log("GOOGLE_ADS_REFRESH_TOKEN");
      console.log(tokens.refresh_token);
      console.log("──────────────────────────────────────────────────────────");
      console.log(
        "\nPut that in Netlify → Site configuration → Environment variables,\n" +
          "alongside GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and\n" +
          "GOOGLE_ADS_CUSTOMER_ID (digits only, no dashes).\n\n" +
          "It is a standing key to the Ads account. Do not commit it, paste it\n" +
          "into a chat, or email it to yourself.\n"
      );
    } catch (err) {
      reply(`Something went wrong: ${err.message}`);
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });

  server.listen(PORT, () => {
    console.log(
      "\nOpen this in a browser, signed in as the account that can see the " +
        "Ads account:\n\n" +
        authUrl(clientId, REDIRECT, state) +
        "\n\nWaiting…\n"
    );
  });
}
