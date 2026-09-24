// Tests for the company-inbox notifications.
//
// Four of these matter more than the rest:
//
//   * a quote that did NOT go out produces no email. The whole point of a
//     confirmation is that it can be trusted, and an inbox that says "texted
//     to the customer" about a text that never left is worse than silence.
//   * accepting an already-accepted quote sends nothing. Without that guard
//     the public token becomes a button anybody can press to mail the
//     company, over and over.
//   * the customer's quote link is never rendered as a clickable link.
//     Opening it marks the quote as read by the customer and changes which
//     follow-up they get — so a confirmation email that invites a click
//     would quietly corrupt the signal the follow-ups are built on.
//   * nothing here can fail the request it rides on.
//
// send-quote.mjs pulls in sms.mjs, which imports followUps.mjs for its
// Supabase helper. That import is stubbed at bundle time, and global fetch is
// replaced, so nothing in this file can reach the network.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- environment, before anything is imported -------------------------------

process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.RESEND_API_KEY = "re_test";
process.env.QUOTE_FROM = "Sky Blue Cleaning Co. <quotes@skybluecleaningco.com>";
process.env.NOTIFY_TO = "company@skybluecleaningco.com";
process.env.PUBLIC_URL = "https://crm.skybluecleaningco.com";
process.env.SMS_MODE = "off";

// --- bundle -----------------------------------------------------------------

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /followUps\.mjs$/ }, (a) => ({ path: a.path, namespace: "fu" }));
    b.onLoad({ filter: /.*/, namespace: "fu" }, () => ({
      contents:
        "export async function rpc(fn, args) { " +
        "  if (globalThis.__rpc) return globalThis.__rpc(fn, args); " +
        "  throw new Error('no network in tests'); }",
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "notify-"));
const out = "verify/.notify-bundle.mjs";

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
          contents: `
            export * from "${process.cwd()}/netlify/lib/notify.mjs";
            export { esc, money, serviceLabels } from "${process.cwd()}/netlify/lib/html.mjs";
            export { default as sendQuote } from "${process.cwd()}/netlify/functions/send-quote.mjs";
            export { default as quotePublic } from "${process.cwd()}/netlify/functions/quote-public.mjs";
          `,
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
    stub,
  ],
  logLevel: "warning",
});

const M = await import("./.notify-bundle.mjs");

// --- harness ----------------------------------------------------------------

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

/**
 * Replace global fetch with a router, and record every call.
 *
 * An unrouted URL throws rather than returning a bland 200. A test that
 * silently lets a real endpoint through would pass while proving nothing.
 */
function routeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: (() => {
        try {
          return opts.body ? JSON.parse(opts.body) : null;
        } catch {
          return opts.body;
        }
      })(),
    };
    calls.push(call);
    for (const [match, reply] of routes) {
      if (call.url.includes(match)) {
        const r = typeof reply === "function" ? reply(call) : reply;
        return {
          ok: r.ok !== false,
          status: r.status || (r.ok === false ? 500 : 200),
          json: async () => (r.body === undefined ? {} : r.body),
        };
      }
    }
    throw new Error(`unrouted fetch: ${call.url}`);
  };
  return calls;
}

const mails = (calls) => calls.filter((c) => c.url.includes("api.resend.com"));
const TOKEN = "a".repeat(64);

// ---------------------------------------------------------------------------
console.log("\n-- is it switched on? --\n");

chk("configured when the address, the from and the key are all set", M.notifyConfigured());

{
  const saved = process.env.NOTIFY_TO;
  delete process.env.NOTIFY_TO;
  chk("no NOTIFY_TO means off, not broken", M.notifyConfigured() === false);

  const calls = routeFetch([]);
  const r = await M.notify({ subject: "x", html: "y" });
  chk("and notify() reports why without calling anything", r.ok === false && r.reason === "no_notify_to" && calls.length === 0,
    `reason=${r.reason} calls=${calls.length}`);
  process.env.NOTIFY_TO = saved;
}

{
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  chk("an address with no mail key is also off", M.notifyConfigured() === false);
  process.env.RESEND_API_KEY = saved;
}

// ---------------------------------------------------------------------------
console.log("\n-- sending one --\n");

{
  const calls = routeFetch([["api.resend.com", { body: { id: "e1" } }]]);
  const r = await M.notify({ subject: "Subject here", html: "<p>body</p>" });
  const m = mails(calls)[0];
  chk("posts to Resend and reports ok", r.ok === true && Boolean(m));
  chk("from the configured sender", m.body.from === process.env.QUOTE_FROM, m.body.from);
  chk("to the company inbox", JSON.stringify(m.body.to) === '["company@skybluecleaningco.com"]', JSON.stringify(m.body.to));
  chk("subject carried through", m.body.subject === "Subject here");
}

{
  const saved = process.env.NOTIFY_TO;
  process.env.NOTIFY_TO = "company@skybluecleaningco.com, hayden@skybluecleaningco.com";
  const calls = routeFetch([["api.resend.com", { body: {} }]]);
  await M.notify({ subject: "s", html: "h" });
  const to = mails(calls)[0].body.to;
  chk("THE POINT: two addresses split into an array, not one string with a comma",
    Array.isArray(to) && to.length === 2 && to[1] === "hayden@skybluecleaningco.com",
    JSON.stringify(to));
  process.env.NOTIFY_TO = saved;
}

{
  routeFetch([["api.resend.com", { ok: false, status: 422, body: { message: "domain not verified" } }]]);
  const r = await M.notify({ subject: "s", html: "h" });
  chk("a rejection is reported, not thrown", r.ok === false && r.reason === "domain not verified", r.reason);
}

{
  globalThis.fetch = async () => {
    throw new Error("socket hang up");
  };
  const r = await M.notify({ subject: "s", html: "h" });
  chk("a dead connection is reported, not thrown", r.ok === false && /socket hang up/.test(r.reason), r.reason);
}

// ---------------------------------------------------------------------------
console.log("\n-- what the sent-confirmation says --\n");

const sentArgs = {
  channel: "text",
  customerName: "Jane O'Brien",
  customerEmail: null,
  customerPhone: "(541) 555-0134",
  address: "412 NW Monroe Ave",
  serviceKeys: ["residential-window-washing", "gutter-cleaning"],
  amount: 450,
  note: "Ladder access round the back",
  // Still passed on purpose, even though the builder ignores it. Dropping it
  // from the fixture would make the assertion below pass because the test
  // stopped supplying a link, not because the email stopped printing one —
  // and the day somebody puts it back in the template, this catches it.
  link: "https://crm.skybluecleaningco.com/q/" + TOKEN,
  expiresAt: "October 18",
  sentByName: "Trenton",
  leadId: "lead-1",
  customerId: null,
};

{
  const { subject, html } = M.quoteSentNotification(sentArgs);
  chk("subject names the channel, the person and the price",
    subject === "Texted a quote — Jane O'Brien, $450.00", subject);
  chk("the destination is in the body", html.includes("(541) 555-0134"));
  chk("service keys are shown as labels, not keys",
    html.includes("Residential window washing") && html.includes("Gutter cleaning") &&
      !html.includes("residential-window-washing"));
  chk("the note is included", html.includes("Ladder access round the back"));
  chk("who sent it is included — that is who the booking fee goes to", html.includes("Trenton"));
  chk("links to the lead in the CRM",
    html.includes('href="https://crm.skybluecleaningco.com/leads/lead-1"'));

  // The one worth breaking the build over.
  //
  // Absent, not merely un-anchored. An earlier version printed the link as
  // plain text with a warning — which Gmail and Apple Mail autolink anyway,
  // so it was a tappable link with a label claiming it wasn't. The only
  // version of this that holds is the token never appearing at all.
  chk("THE POINT: the customer's quote link is not in the email at all",
    !html.includes(TOKEN) && !html.includes("/q/"),
    "opening a quote link marks it viewed and changes which follow-up the customer gets");
  chk("and no leftover caption pointing at a link that isn't there",
    !/link the customer/i.test(html));
}

{
  const { subject, html } = M.quoteSentNotification({
    ...sentArgs,
    channel: "email",
    customerEmail: "jane@example.com",
    customerPhone: null,
  });
  chk("an emailed quote says Emailed", subject.startsWith("Emailed a quote"), subject);
  chk("and names the address it went to", html.includes("jane@example.com"));
}

{
  const { html } = M.quoteSentNotification({
    ...sentArgs,
    leadId: null,
    customerId: "cust-9",
  });
  chk("a quote against a customer links to the customer",
    html.includes('href="https://crm.skybluecleaningco.com/customers/cust-9"'));
}

{
  const { html } = M.quoteSentNotification({ ...sentArgs, note: null });
  chk("no note, no note block", !html.includes("Note on the quote"));
}

// ---------------------------------------------------------------------------
console.log("\n-- escaping --\n");

{
  const { subject, html } = M.quoteSentNotification({
    ...sentArgs,
    customerName: '<script>alert(1)</script>',
    address: 'Corner of "A" & B',
  });
  chk("a script tag in a name cannot become markup",
    !html.includes("<script>") && html.includes("&lt;script&gt;"));
  chk("ampersands and quotes in an address are escaped",
    html.includes("&quot;A&quot; &amp; B"));
  chk("an apostrophe is escaped too, so it is safe in an attribute",
    M.esc("O'Brien") === "O&#39;Brien", M.esc("O'Brien"));
  // The subject is a header, not markup — it must NOT carry entities.
  chk("the subject line is left as plain text", subject.includes("<script>"), subject);
}

{
  chk("money always shows cents", M.money(450) === "$450.00" && M.money(1200.5) === "$1,200.50");
  chk("an unknown service key falls back to the key rather than vanishing",
    M.serviceLabels(["made-up"])[0] === "made-up");
}

// ---------------------------------------------------------------------------
console.log("\n-- the acceptance --\n");

{
  const { subject, html } = M.quoteAcceptedNotification({
    customerName: "Jane O'Brien",
    address: "412 NW Monroe Ave",
    serviceKeys: ["residential-window-washing"],
    amount: 450,
    sentByName: "Trenton",
    leadId: "lead-1",
    customerId: null,
  });
  chk("subject leads with ACCEPTED so it is distinguishable at a glance",
    subject === "ACCEPTED — Jane O'Brien, $450.00", subject);
  chk("it says the lead is now Booked and needs scheduling", /Booked/.test(html) && /schedule/i.test(html));
  chk("it credits whoever quoted it", html.includes("Trenton"));
  chk("and the button goes to the record", html.includes("https://crm.skybluecleaningco.com/leads/lead-1"));
  chk("no customer quote link on an acceptance — there is nothing left to check",
    !html.includes("/q/"));
}

// ---------------------------------------------------------------------------
console.log("\n-- accepting, end to end --\n");

function acceptRequest() {
  return new Request(`https://crm.skybluecleaningco.com/api/quote/${TOKEN}`, { method: "POST" });
}

const quoteRow = [
  {
    customer_name: "Jane O'Brien",
    address: "412 NW Monroe Ave",
    service_keys: ["residential-window-washing"],
    amount: 450,
    lead_id: "lead-1",
    customer_id: null,
    sent_by: "user-1",
  },
];

{
  const calls = routeFetch([
    ["rpc/sb_accept_quote", { body: [{ ok: true, reason: "accepted", already: false }] }],
    ["/rest/v1/quotes?", { body: quoteRow }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Trenton" }] }],
    ["api.resend.com", { body: { id: "e2" } }],
  ]);

  const res = await M.quotePublic(acceptRequest());
  const out = await res.json();
  const m = mails(calls)[0];

  chk("a genuine acceptance still answers the customer", out.ok === true && out.already === false);
  chk("and mails the company", Boolean(m), `mails=${mails(calls).length}`);
  chk("with the sender's name looked up", m && m.body.html.includes("Trenton"));
  chk("subject says ACCEPTED", m && m.body.subject.startsWith("ACCEPTED"), m?.body?.subject);
}

{
  const calls = routeFetch([
    ["rpc/sb_accept_quote", { body: [{ ok: true, reason: "already_accepted", already: true }] }],
    ["/rest/v1/quotes?", { body: quoteRow }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Trenton" }] }],
    ["api.resend.com", { body: {} }],
  ]);

  const res = await M.quotePublic(acceptRequest());
  const out = await res.json();

  chk("THE POINT: a second acceptance still succeeds for the customer", out.ok === true && out.already === true);
  chk("THE POINT: but sends nothing — the token is not a button for mailing the company",
    mails(calls).length === 0, `mails=${mails(calls).length}`);
}

{
  const calls = routeFetch([
    ["rpc/sb_accept_quote", { body: [{ ok: false, reason: "expired", already: false }] }],
    ["api.resend.com", { body: {} }],
  ]);
  const out = await (await M.quotePublic(acceptRequest())).json();
  chk("an expired quote notifies nobody", out.ok === false && mails(calls).length === 0);
}

{
  // The acceptance is committed before any of this runs. Losing the email is
  // acceptable; showing the customer an error is not.
  const calls = routeFetch([
    ["rpc/sb_accept_quote", { body: [{ ok: true, reason: "accepted", already: false }] }],
    ["/rest/v1/quotes?", { ok: false, status: 500, body: { message: "boom" } }],
    ["api.resend.com", { body: {} }],
  ]);
  const res = await M.quotePublic(acceptRequest());
  const out = await res.json();
  chk("THE POINT: a failure while notifying never reaches the customer",
    res.status === 200 && out.ok === true && mails(calls).length === 0);
}

{
  const calls = routeFetch([
    ["rpc/sb_accept_quote", { body: [{ ok: true, reason: "accepted", already: false }] }],
    ["/rest/v1/quotes?", { body: quoteRow }],
    ["/rest/v1/profiles?", { ok: false, status: 500, body: { message: "no" } }],
    ["api.resend.com", { body: {} }],
  ]);
  const out = await (await M.quotePublic(acceptRequest())).json();
  chk("a missing sender name still sends the email", out.ok === true && mails(calls).length === 1,
    `mails=${mails(calls).length}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- sending a quote, end to end --\n");

function sendRequest(body) {
  return new Request("https://crm.skybluecleaningco.com/api/send-quote", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseQuote = {
  leadId: "lead-1",
  customerName: "Jane O'Brien",
  address: "412 NW Monroe Ave",
  serviceKeys: ["residential-window-washing"],
  amount: 450,
};

{
  const calls = routeFetch([
    ["/auth/v1/user", { body: { id: "user-1" } }],
    ["/rest/v1/quotes", { body: [{ id: "q1", token: TOKEN }] }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Jordan" }] }],
    ["api.resend.com", (c) => ({ body: { id: c.body.to[0] === "jane@example.com" ? "quote" : "notif" } })],
  ]);

  const out = await (
    await M.sendQuote(sendRequest({ ...baseQuote, customerEmail: "jane@example.com", channel: "email" }))
  ).json();

  const sent = mails(calls);
  chk("the quote is emailed to the customer", out.emailed === true && sent.some((m) => m.body.to[0] === "jane@example.com"));
  chk("and a copy goes to the company", sent.some((m) => m.body.to[0] === "company@skybluecleaningco.com"),
    JSON.stringify(sent.map((m) => m.body.to)));
  const notif = sent.find((m) => m.body.to[0] === "company@skybluecleaningco.com");
  chk("the copy says Emailed, not Texted", notif && notif.body.subject.startsWith("Emailed a quote"), notif?.body?.subject);
  chk("exactly one copy, not one per recipient", sent.filter((m) => m.body.to[0] === "company@skybluecleaningco.com").length === 1);
}

{
  // SMS_MODE is off, which is the live state until A2P clears. The quote is
  // still created and the link still comes back — but nothing was texted.
  const calls = routeFetch([
    ["/auth/v1/user", { body: { id: "user-1" } }],
    ["/rest/v1/quotes", { body: [{ id: "q2", token: TOKEN }] }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Jordan" }] }],
    ["api.resend.com", { body: {} }],
  ]);

  const out = await (
    await M.sendQuote(sendRequest({ ...baseQuote, customerPhone: "(541) 555-0134", channel: "text" }))
  ).json();

  chk("the quote exists and the link comes back", Boolean(out.link) && out.texted === false);
  chk("THE POINT: nothing was sent, so nothing claims it was",
    mails(calls).length === 0, `mails=${mails(calls).length}`);
}

{
  process.env.SMS_MODE = "send";
  process.env.QUO_API_KEY = "quo-key";
  process.env.QUO_FROM = "+15417303593";
  globalThis.__rpc = async (fn) => {
    if (fn === "claim_sms") return [{ id: "s1", ok: true, reason: null, phone: "+15415550134" }];
    return [{}];
  };

  const calls = routeFetch([
    ["/auth/v1/user", { body: { id: "user-1" } }],
    ["/rest/v1/quotes", { body: [{ id: "q3", token: TOKEN }] }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Jordan" }] }],
    ["api.quo.com", { body: { id: "m1" } }],
    ["api.resend.com", { body: {} }],
  ]);

  const out = await (
    await M.sendQuote(sendRequest({ ...baseQuote, customerPhone: "(541) 555-0134", channel: "text" }))
  ).json();

  const notif = mails(calls)[0];
  chk("a text that actually goes out is confirmed", out.texted === true && Boolean(notif));
  chk("and the copy says Texted", notif && notif.body.subject.startsWith("Texted a quote"), notif?.body?.subject);
  chk("naming the number it went to", notif && notif.body.html.includes("(541) 555-0134"));

  delete globalThis.__rpc;
  process.env.SMS_MODE = "off";
}

{
  // The confirmation is a courtesy. The quote is the product.
  process.env.SMS_MODE = "off";
  const calls = routeFetch([
    ["/auth/v1/user", { body: { id: "user-1" } }],
    ["/rest/v1/quotes", { body: [{ id: "q4", token: TOKEN }] }],
    ["/rest/v1/profiles?", { body: [{ full_name: "Jordan" }] }],
    ["api.resend.com", (c) =>
      c.body.to[0] === "company@skybluecleaningco.com"
        ? { ok: false, status: 500, body: { message: "notify is down" } }
        : { body: { id: "quote" } },
    ],
  ]);

  const res = await M.sendQuote(sendRequest({ ...baseQuote, customerEmail: "jane@example.com", channel: "email" }));
  const out = await res.json();
  chk("THE POINT: a failed confirmation never fails the quote",
    res.status === 200 && out.emailed === true && Boolean(out.link));
  chk("and it was genuinely attempted", mails(calls).some((m) => m.body.to[0] === "company@skybluecleaningco.com"));
}

{
  const saved = process.env.NOTIFY_TO;
  delete process.env.NOTIFY_TO;
  const calls = routeFetch([
    ["/auth/v1/user", { body: { id: "user-1" } }],
    ["/rest/v1/quotes", { body: [{ id: "q5", token: TOKEN }] }],
    ["api.resend.com", { body: {} }],
  ]);
  const out = await (
    await M.sendQuote(sendRequest({ ...baseQuote, customerEmail: "jane@example.com", channel: "email" }))
  ).json();
  // This used to assert that NO profile was read — the sender's name was
  // only ever used for the internal notification, so looking it up with
  // nowhere to send that notification was wasted work on every quote.
  //
  // db/quote-sender-name.sql changed what the name is FOR. It now signs the
  // customer's own quote, so it is needed whether or not anybody is being
  // notified, and reading it exactly once is the point of resolving it up
  // front rather than at each of the three places that want it.
  chk("with no NOTIFY_TO the quote still sends",
    out.emailed === true);
  const profileReads = calls.filter((c) => c.url.includes("/rest/v1/profiles")).length;
  chk("THE POINT: the sender's name is read once, and still read with nobody to notify",
    profileReads === 1, `${profileReads} profile lookups`);
  process.env.NOTIFY_TO = saved;
}

// ---------------------------------------------------------------------------
console.log(bad === 0 ? "\nall ok — notifications hold\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
