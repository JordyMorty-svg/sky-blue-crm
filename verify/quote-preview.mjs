// Tests for staff previewing a quote without marking it read.
//
// The bug this exists to prevent, stated plainly: the Quotes panel offers
// "Copy link". Pasting that link into a browser loaded the customer's quote
// page, which flipped the quote from 'sent' to 'viewed' — so the CRM said the
// customer had opened a quote they had never seen, and the follow-up system
// then chased them with the wrong message, or with none.
//
// The fix moves the decision out of the database, which cannot tell a rep
// from a customer, and up into the function that serves the page, which can
// verify a bearer token. These tests are about that decision and nothing
// else: for each kind of caller, is the quote marked, and may they accept?
//
// The two that matter most:
//
//   * staff GET does not mark, and staff POST never reaches sb_accept_quote
//   * a caller we could not IDENTIFY is treated as staff on both, because
//     wrongly skipping a view is recoverable and wrongly booking a job is not
//
// quote-public.mjs imports only netlify/lib/notify.mjs, which is pure, so
// this needs no bundling — just a routed global fetch.

process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_KEY = "service-key";
// Left unset: the acceptance notification is tested in verify/notify.mjs, and
// switching it off here keeps these routes to the calls under test.
delete process.env.NOTIFY_TO;

const { default: quotePublic } = await import("../netlify/functions/quote-public.mjs");

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const TOKEN = "b".repeat(64);
const URL_ = `https://crm.skybluecleaningco.com/api/quote/${TOKEN}`;

const QUOTE = [
  {
    customer_name: "Jane O'Brien",
    address: "412 NW Monroe Ave",
    service_keys: ["residential-window-washing"],
    amount: 450,
    note: null,
    status: "sent",
    expires_at: "2099-01-01T00:00:00Z",
    expired: false,
    accepted_at: null,
  },
];

/**
 * Route fetch and record every call.
 *
 * `auth` decides what Supabase Auth says about the bearer token:
 *   "ok"       — a real user
 *   "reject"   — 401, an expired or bogus token
 *   "broken"   — 500, we asked and could not get an answer
 *   "throw"    — the network is gone
 */
function routeFetch({ auth = "ok", accept = { ok: true, reason: "accepted", already: false } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method || "GET",
      body: (() => {
        try {
          return opts.body ? JSON.parse(opts.body) : null;
        } catch {
          return opts.body;
        }
      })(),
    };
    calls.push(call);

    if (call.url.includes("/auth/v1/user")) {
      if (auth === "throw") throw new Error("network down");
      if (auth === "reject") return { ok: false, status: 401, json: async () => ({}) };
      if (auth === "broken") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "user-1" }) };
    }
    if (call.url.includes("rpc/sb_quote_public")) {
      return { ok: true, status: 200, json: async () => QUOTE };
    }
    if (call.url.includes("rpc/sb_accept_quote")) {
      return { ok: true, status: 200, json: async () => [accept] };
    }
    throw new Error(`unrouted fetch: ${call.url}`);
  };
  return calls;
}

const get = (headers = {}) => quotePublic(new Request(URL_, { headers }));
const post = (headers = {}) => quotePublic(new Request(URL_, { method: "POST", headers }));
const STAFF = { authorization: "Bearer staff-token" };

const markCall = (calls) => calls.find((c) => c.url.includes("rpc/sb_quote_public"));
const acceptCall = (calls) => calls.find((c) => c.url.includes("rpc/sb_accept_quote"));

// ---------------------------------------------------------------------------
console.log("\n-- reading the quote --\n");

{
  const calls = routeFetch();
  const out = await (await get()).json();
  chk("a customer gets the quote", Boolean(out.quote));
  chk("and is recorded as having opened it", markCall(calls).body.p_mark === true,
    `p_mark=${markCall(calls).body.p_mark}`);
  chk("the page is not told it is a preview", out.preview === false);
  chk("no time wasted asking who an anonymous caller is",
    !calls.some((c) => c.url.includes("/auth/v1/user")));
}

{
  const calls = routeFetch({ auth: "ok" });
  const out = await (await get(STAFF)).json();
  chk("THE POINT: a signed-in member of staff does NOT mark the quote read",
    markCall(calls).body.p_mark === false,
    "this is the bug — Copy link, pasted into a browser, said the customer had read it");
  chk("and the page is told, so it can say so", out.preview === true);
  chk("they still see the quote itself", Boolean(out.quote));
}

{
  const calls = routeFetch({ auth: "reject" });
  const out = await (await get(STAFF)).json();
  chk("a token Supabase REJECTS is the public — an expired tab is not staff",
    markCall(calls).body.p_mark === true && out.preview === false,
    `p_mark=${markCall(calls).body.p_mark} preview=${out.preview}`);
}

{
  const calls = routeFetch({ auth: "broken" });
  const out = await (await get(STAFF)).json();
  chk("THE POINT: a caller we could not identify is not recorded as a view",
    markCall(calls).body.p_mark === false && out.preview === true,
    "a view we cannot attribute is worse than a view we never recorded");
}

{
  const calls = routeFetch({ auth: "throw" });
  await (await get(STAFF)).json();
  chk("same when the auth check throws outright", markCall(calls).body.p_mark === false);
}

{
  const saved = process.env.VITE_SUPABASE_ANON_KEY;
  delete process.env.VITE_SUPABASE_ANON_KEY;
  const calls = routeFetch();
  await (await get(STAFF)).json();
  chk("and same with no anon key to verify against — it fails closed, not open",
    markCall(calls).body.p_mark === false,
    "a missing env var must not silently reintroduce the bug");
  process.env.VITE_SUPABASE_ANON_KEY = saved;
}

// ---------------------------------------------------------------------------
console.log("\n-- accepting --\n");

{
  const calls = routeFetch();
  const out = await (await post()).json();
  chk("a customer can accept", out.ok === true && Boolean(acceptCall(calls)));
}

{
  const calls = routeFetch({ auth: "ok" });
  const res = await post(STAFF);
  const out = await res.json();
  chk("THE POINT: staff cannot accept on the customer's behalf",
    out.ok === false && out.reason === "staff_preview", JSON.stringify(out));
  chk("THE POINT: and sb_accept_quote is never even called",
    !acceptCall(calls),
    "refusing after the fact would still have booked the job and paid the commission");
  chk("answered 200 with a reason, like every other outcome here", res.status === 200);
}

{
  const calls = routeFetch({ auth: "reject" });
  const out = await (await post(STAFF)).json();
  chk("a customer on a stale session can still accept",
    out.ok === true && Boolean(acceptCall(calls)));
}

{
  const calls = routeFetch({ auth: "broken" });
  const out = await (await post(STAFF)).json();
  chk("but an unidentifiable caller cannot book a job",
    out.ok === false && out.reason === "staff_preview" && !acceptCall(calls));
}

// ---------------------------------------------------------------------------
console.log("\n-- the things that must not have changed --\n");

{
  routeFetch();
  const res = await quotePublic(new Request("https://crm.skybluecleaningco.com/api/quote/nope"));
  chk("a malformed token is still an indistinguishable 404", res.status === 404);
}

{
  const calls = routeFetch({ auth: "ok" });
  const res = await get(STAFF);
  chk("a preview response is never cached",
    res.headers.get("Cache-Control") === "no-store",
    "a CDN serving a preview to a customer would reintroduce this exactly");
  chk("staff are identified before the quote is read, not after",
    calls.findIndex((c) => c.url.includes("/auth/v1/user")) <
      calls.findIndex((c) => c.url.includes("rpc/sb_quote_public")));
}

// ---------------------------------------------------------------------------
console.log(bad === 0 ? "\nall ok — previewing is safe\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
