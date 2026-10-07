// The one-off script that fetches a refresh token: node verify/google-oauth.mjs
//
// A developer tool, tested anyway, because its two failure modes are both
// SILENT and both cost an afternoon:
//
//   * a consent URL missing access_type=offline returns an access token and
//     no refresh token, so the script appears broken rather than misconfigured
//   * a URL missing prompt=consent works the FIRST time and never again,
//     which is precisely when somebody is re-running it under pressure
//
// Neither throws. Both just produce a response with one fewer field than
// expected, which is the shape of mistake this project keeps being bitten by.
//
// Checks marked THE POINT are the ones this file exists for.

import { authUrl, exchange, SCOPE } from "../scripts/google-oauth.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

console.log("\n-- the consent URL --\n");

{
  const url = new URL(authUrl("client-123.apps.googleusercontent.com", "http://localhost:8787/cb", "st8"));

  chk("it goes to Google's consent endpoint",
    url.origin + url.pathname === "https://accounts.google.com/o/oauth2/v2/auth",
    url.origin + url.pathname);

  chk("THE POINT: access_type is offline",
    url.searchParams.get("access_type") === "offline",
    "without it Google returns an access token and NO refresh token — the " +
      "exchange succeeds, nothing useful is printed, and the script looks broken");

  chk("THE POINT: consent is forced every time",
    url.searchParams.get("prompt") === "consent",
    "without it a second run for an already-approved account returns no " +
      "refresh token either, because Google only issues one on first consent. " +
      "It works once and never again when you need to redo it");

  chk("it asks for a code, not a token",
    url.searchParams.get("response_type") === "code");

  chk("the client id and redirect are passed through",
    url.searchParams.get("client_id") === "client-123.apps.googleusercontent.com" &&
      url.searchParams.get("redirect_uri") === "http://localhost:8787/cb");

  chk("the state is carried, so a stray request cannot be mistaken for this one",
    url.searchParams.get("state") === "st8");

  chk("...and is left off when there is none",
    !new URL(authUrl("id")).searchParams.has("state"));

  // THE SCOPE IS NARROW ON PURPOSE. This token can read every lead and every
  // dollar of spend in the account; there is no reason for it to also carry
  // Drive or Gmail, and a wider scope is also what turns an unverified app
  // from "click Advanced" into "needs a full verification review".
  chk("THE POINT: it asks for the Ads scope and nothing else",
    url.searchParams.get("scope") === SCOPE && SCOPE === "https://www.googleapis.com/auth/adwords",
    `scope = ${url.searchParams.get("scope")}`);
}

console.log("\n-- the exchange --\n");

{
  const good = async (urlArg, opts) => {
    const body = new URLSearchParams(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "at",
        refresh_token: "rt",
        _sent: Object.fromEntries(body),
      }),
    };
  };

  const tokens = await exchange({
    code: "the-code",
    clientId: "id",
    clientSecret: "secret",
    redirect: "http://localhost:8787/cb",
    fetchImpl: good,
  });

  chk("a good exchange returns the refresh token", tokens.refresh_token === "rt");

  chk("the code is sent as an authorization_code grant",
    tokens._sent.grant_type === "authorization_code" && tokens._sent.code === "the-code",
    JSON.stringify(tokens._sent));

  chk("THE POINT: the redirect matches the one consent was given for",
    tokens._sent.redirect_uri === "http://localhost:8787/cb",
    "a mismatch is rejected as redirect_uri_mismatch, which does not say " +
      "which URI Google expected");

  // THE FAILURE THIS SCRIPT EXISTS TO MAKE LEGIBLE. A 200 with an access
  // token and no refresh token is Google saying "consent was remembered",
  // and reads as success everywhere except where it matters.
  let threw = "";
  try {
    await exchange({
      code: "c",
      clientId: "id",
      clientSecret: "s",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: "at" }) }),
    });
  } catch (e) {
    threw = e.message;
  }
  chk("THE POINT: a 200 with no refresh token is a failure, and says why",
    /no refresh token/i.test(threw) && /approved before/i.test(threw),
    `${threw || "(did not throw)"} — this is the one that looks like success`);

  chk("...and says where to revoke it",
    /myaccount\.google\.com\/permissions/.test(threw),
    "the fix is one page, and nobody finds it from 'no refresh token'");

  threw = "";
  try {
    await exchange({
      code: "c",
      clientId: "id",
      clientSecret: "s",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant", error_description: "Code was already redeemed." }),
      }),
    });
  } catch (e) {
    threw = e.message;
  }
  chk("a refused code carries Google's own words",
    /invalid_grant/.test(threw) && /already redeemed/.test(threw),
    threw);
}

console.log("\n-- the warnings that have to stay in the file --\n");

{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("scripts/google-oauth.mjs", "utf8");

  // THE SEVEN-DAY TRAP. Google expires every refresh token issued by an app
  // in Testing after exactly a week. The hourly poll runs fine all week and
  // then fails with invalid_grant, which reads like somebody revoked access
  // rather than like a dropdown nobody changed.
  chk("THE POINT: the file warns about Testing mode expiring tokens in 7 days",
    /SEVEN DAYS|7 days/i.test(src) && /Testing/i.test(src) && /PUBLISH/i.test(src),
    "this is the single most expensive thing to not know here: it works " +
      "perfectly for a week");

  chk("...and names Internal as the way out for a Workspace account",
    /INTERNAL/.test(src));

  chk("the client type that avoids registering a redirect URI is named",
    /Desktop app/i.test(src) && /redirect_uri_mismatch/.test(src));

  // The token must not end up anywhere but Netlify.
  chk("THE POINT: the script says not to commit or paste the token",
    /Do not commit it, paste it/i.test(src),
    "it is a standing key to an account that spends money");

  chk("nothing is written to a file",
    !/writeFileSync|appendFileSync|createWriteStream/.test(src),
    "a refresh token on disk is a refresh token in a backup");
}

console.log(bad === 0 ? "\nall ok — the token it fetches is one that still works next week\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
