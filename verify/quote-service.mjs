// Unit tests for the pure half of quoteService.
//
// These four functions are the ones with no server behind them to catch a
// mistake: a malformed sms: href silently drops the message body on iOS, and
// quoteState decides what the office believes about a quote nobody can see.
//
// quoteService imports the browser Supabase client, so the module is bundled
// with that import stubbed out. Nothing here touches the network.
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = {
  name: "stub-supabase",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({
      path: a.path,
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      // A faithful shim, not a convenient one: supabase-js RESOLVES with
      // { data, error } and does not throw, so the stub returns whatever the
      // test hands it unchanged. A stub that returned a bare array would have
      // let a destructuring bug through — the first version of this file did
      // exactly that and every row came back empty.
      contents:
        "export const supabase = { rpc: async (fn, args) => globalThis.__rpc(fn, args) };",
      loader: "js",
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), "qs-"));
const out = join(dir, "bundle.mjs");

await build({
  entryPoints: ["src/services/quoteService.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  plugins: [stub],
  logLevel: "warning",
});

const {
  SERVICE_LABELS,
  SERVICE_OPTIONS,
  describeLoadError,
  fetchQuotes,
  quotable,
  quoteState,
  smsHref,
  smsText,
  money,
  shortDate,
  viewSummary,
} = await import(out);

let bad = 0;
function chk(what, pass, detail = "") {
  if (pass) {
    console.log(`ok    ${what}`);
  } else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad++;
  }
}

// --- sms links -------------------------------------------------------------
// The separator is the whole trick. iOS honours `sms:<number>&body=`; with a
// `?` there it drops the body and you send a blank message with no link in it.
{
  const href = smsHref("(541) 730-3593", "hello there");
  chk("sms href normalises to 11 digits", href.startsWith("sms:15417303593&"), href);
  chk("sms href uses & before body when a number is present", href.includes("&body="), href);
  chk("sms body is url-encoded", href.includes("hello%20there"), href);
}
{
  // No number on file: there is nothing to address, so the separator must
  // flip to `?` or the href is malformed and opens nothing at all.
  const href = smsHref("", "hi");
  chk("sms href with no number uses ?body=", href === "sms:?body=hi", href);
}
{
  const href = smsHref("15417303593", "hi");
  chk("an 11-digit number is left alone", href.startsWith("sms:15417303593&"), href);
}
{
  const link = "https://crm.skybluecleaningco.com/q/abc";
  const href = smsHref("5417303593", smsText({ customerName: "Karen Emery", amount: 475, link }));
  chk(
    "the link survives encoding intact",
    decodeURIComponent(href.split("&body=")[1]).endsWith(link),
    href
  );
}

// --- the message ------------------------------------------------------------
{
  const body = smsText({
    customerName: "Karen Emery",
    amount: 475,
    link: "https://x/q/t",
  });
  chk("uses the first name only", body.includes("Hey Karen,") && !body.includes("Emery"), body);
  chk("price has no cents", body.includes("$475") && !body.includes("475.00"), body);
  chk("the link is last", body.trim().endsWith("https://x/q/t"), body);
}
{
  const body = smsText({ customerName: "", amount: 100, link: "https://x/q/t" });
  chk("a missing name degrades to 'there'", body.startsWith("Hey there,"), body);
}

// --- state ------------------------------------------------------------------
const future = new Date(Date.now() + 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

chk(
  "sent and in date reads as sent",
  quoteState({ status: "sent", expires_at: future }).key === "sent"
);
chk(
  "viewed and in date reads as viewed",
  quoteState({ status: "viewed", expires_at: future }).key === "viewed"
);
chk(
  "past its date reads as expired",
  quoteState({ status: "sent", expires_at: past }).key === "expired"
);
// The one that matters: sb_accept_quote refuses an expired token, but an
// ACCEPTED quote is already booked work. If expiry outranked acceptance here,
// a job on the calendar would show as expired a month later.
chk(
  "accepted outranks expired",
  quoteState({ status: "accepted", expires_at: past }).key === "accepted",
  quoteState({ status: "accepted", expires_at: past }).key
);
chk(
  "declined outranks expired",
  quoteState({ status: "declined", expires_at: past }).key === "declined"
);
chk(
  "a draft link reads as created, not sent",
  quoteState({ status: "draft", expires_at: future }).key === "draft"
);

// --- money and dates --------------------------------------------------------
chk("money always shows cents", money(250) === "$250.00", money(250));
chk("money groups thousands", money(1250.5) === "$1,250.50", money(1250.5));
chk("money survives null", money(null) === "$0.00", money(null));
chk("shortDate survives null", shortDate(null) === "", `"${shortDate(null)}"`);

// --- the service list -------------------------------------------------------
// Derived from leadService.SERVICE_TYPES rather than restated. If that list
// grows, this picks it up; if someone restates it here, this notices.
chk(
  "every service option has a label",
  SERVICE_OPTIONS.length > 0 && SERVICE_OPTIONS.every((s) => s.key && s.label)
);
chk(
  "labels map covers the options",
  SERVICE_OPTIONS.every((s) => SERVICE_LABELS[s.key] === s.label)
);
chk(
  "the window-washing default is a real key",
  !!SERVICE_LABELS["residential-window-washing"],
  Object.keys(SERVICE_LABELS).join(", ")
);
chk(
  "the list matches the CRM's own service types",
  SERVICE_OPTIONS.length === 6,
  `${SERVICE_OPTIONS.length} options`
);

// --- fetching a person's quotes --------------------------------------------
//
// The reshaping matters because the panel reads `sender.full_name`, the shape
// the old embedded PostgREST select produced. The RPC returns a flat
// sender_name instead, and a quiet mismatch here shows up as every quote in
// the list losing the name of whoever sent it.
{
  let called = null;
  globalThis.__rpc = async (fn, args) => {
    called = { fn, args };
    return {
      data: [
        {
          id: "q1",
          lead_id: "lead-1",
          customer_id: null,
          amount: 250,
          status: "accepted",
          sender_name: "Jordan Mortensen",
          from_elsewhere: true,
        },
        { id: "q2", lead_id: null, customer_id: "cust-1", amount: 300, status: "sent", sender_name: null },
      ],
      error: null,
    };
  };

  const rows = await fetchQuotes({ customerId: "cust-1" });

  chk("it asks the database for the whole person, not one row",
    called.fn === "quotes_for_contact", called?.fn);
  chk("and passes the id it was given",
    called.args.p_customer_id === "cust-1" && called.args.p_lead_id === null,
    JSON.stringify(called.args));
  chk("the sender survives as the shape the panel reads",
    rows[0].sender?.full_name === "Jordan Mortensen",
    JSON.stringify(rows[0].sender));
  chk("a quote with no sender is null, not an empty name object",
    rows[1].sender === null, JSON.stringify(rows[1].sender));
  chk("THE POINT: a lead's quote comes back flagged as from elsewhere",
    rows[0].from_elsewhere === true);
}

{
  // Asking about nobody must not hit the database at all — a stray call with
  // two nulls would ask contact_identity to resolve "no one".
  let hit = false;
  globalThis.__rpc = async () => {
    hit = true;
    return { data: [], error: null };
  };
  const rows = await fetchQuotes({});
  chk("with neither id it returns nothing without calling the database",
    rows.length === 0 && !hit);
}

{
  globalThis.__rpc = async () => ({ data: null, error: null });
  chk("a null result is an empty list, not a crash",
    (await fetchQuotes({ leadId: "lead-1" })).length === 0);
}

{
  // supabase-js reports a database failure in `error`, it does not throw.
  globalThis.__rpc = async () => ({ data: null, error: new Error("boom") });
  let threw = false;
  try {
    await fetchQuotes({ leadId: "lead-1" });
  } catch {
    threw = true;
  }
  // The panel catches this and says "Couldn't load past quotes" rather than
  // rendering an empty list — which would read as "we never quoted them".
  chk("a failure is thrown, so the panel can say so instead of showing nothing",
    threw);
}

// --- what the panel says when the list won't load ---------------------------
//
// "Couldn't load past quotes" on every customer at once is what shipped, and
// it sent somebody into DevTools for a message the code already had. The
// frontend and the database deploy separately, so the code being ahead of the
// schema is a normal state for a few minutes — and it has to say so.
{
  // supabase-js hands back a plain object, not an Error, so the code is read
  // off `.code` rather than caught by instanceof.
  const missingFn = {
    code: "PGRST202",
    message:
      "Could not find the function public.quotes_for_contact(p_customer_id, p_lead_id) in the schema cache",
  };
  chk(
    "THE POINT: a missing migration names the file to run",
    /quote-history\.sql/.test(describeLoadError(missingFn)),
    describeLoadError(missingFn)
  );
  chk(
    "recognised by PostgREST's message as well as its code",
    /quote-history\.sql/.test(
      describeLoadError({ message: "Could not find the function foo" })
    )
  );
  chk(
    "a permissions failure says something different",
    /grant/i.test(describeLoadError({ code: "42501", message: "permission denied" })),
    describeLoadError({ code: "42501", message: "permission denied" })
  );
  chk(
    "anything else still carries the underlying message",
    describeLoadError({ message: "connection reset" }).includes("connection reset"),
    describeLoadError({ message: "connection reset" })
  );
  chk(
    "and an error with nothing in it does not print 'undefined'",
    !/undefined/.test(describeLoadError({})) && !/undefined/.test(describeLoadError(null)),
    `${describeLoadError({})} / ${describeLoadError(null)}`
  );
}

// --- whether to offer the quote after creating a lead ----------------------
//
// Asked by BOTH Add lead forms — the page and the pin on the map — which is
// why it is one function and not a condition written out twice.
{
  const base = { id: "l1", status: "quoted", name: "Marilyn", estimate: 250 };

  chk("a quoted lead with a phone is worth offering", quotable({ ...base, phone: "5415550101" }));
  chk("a quoted lead with an email is too", quotable({ ...base, email: "a@b.com" }));

  // THE POINT of the guard. The map's form collects a phone and no email, so
  // "has an email" would have silently skipped every lead added from a pin.
  chk(
    "THE POINT: a phone alone is enough — the map form collects no email",
    quotable({ ...base, phone: "5415550101", email: null })
  );

  chk(
    "a quoted lead with no way to reach them is not offered",
    !quotable({ ...base, phone: null, email: null }),
    "the modal would open only to say it cannot do anything"
  );
  chk(
    "a contacted lead is not offered — there is no quote yet",
    !quotable({ ...base, status: "contacted", phone: "5415550101" })
  );
  chk(
    "a booked lead is not offered either",
    !quotable({ ...base, status: "booked", phone: "5415550101" })
  );
  chk("a row with no id is not offered", !quotable({ ...base, id: null, phone: "5415550101" }));
  chk("and nothing at all does not throw", !quotable(null) && !quotable(undefined));
}

// ---------------------------------------------------------------------------
{
  console.log("\n-- how many times they opened it --\n");

  chk("a quote nobody has opened says nothing at all",
    viewSummary({ view_count: 0 }) === null,
    "the status already says 'not opened yet'; a zero here is noise on every unread row");

  chk("one open reads as words, not a number",
    viewSummary({ view_count: 1 }) === "opened once",
    viewSummary({ view_count: 1 }));

  chk("THE POINT: more than once is the signal, and it says when",
    viewSummary({ view_count: 4, last_viewed_at: "2026-09-20T12:00:00Z" }) ===
      "opened 4 times, last Sep 20, 2026",
    viewSummary({ view_count: 4, last_viewed_at: "2026-09-20T12:00:00Z" }));

  chk("falls back to viewed_at when there is no last_viewed_at",
    viewSummary({ view_count: 3, viewed_at: "2026-09-19T12:00:00Z" }) ===
      "opened 3 times, last Sep 19, 2026");

  chk("and drops the date rather than printing an empty one",
    viewSummary({ view_count: 3 }) === "opened 3 times",
    viewSummary({ view_count: 3 }));

  chk("a missing count is not an open",
    viewSummary({}) === null && viewSummary(null) === null && viewSummary(undefined) === null);

  chk("a count that arrived as a string still counts",
    viewSummary({ view_count: "2", last_viewed_at: "2026-09-20T12:00:00Z" }) ===
      "opened 2 times, last Sep 20, 2026",
    "PostgREST has handed back numerics as strings before");

  chk("nonsense never renders as NaN",
    viewSummary({ view_count: "lots" }) === null);
}

// --- which way a quote goes out -------------------------------------------
//
// Bundled from the Netlify function, which imports nothing that needs a
// server for this one export.
{
  const bundled = join(dir, "channel.mjs");
  await build({
    entryPoints: ["netlify/functions/send-quote.mjs"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundled,
    external: ["../lib/sms.mjs"],
    logLevel: "silent",
    plugins: [
      {
        name: "stub-sms",
        setup(b) {
          b.onResolve({ filter: /lib\/sms\.mjs$/ }, (a) => ({ path: a.path, namespace: "s" }));
          b.onLoad({ filter: /.*/, namespace: "s" }, () => ({
            contents: "export const sendSms = async () => ({ ok: false }); export const quoteSms = () => '';",
            loader: "js",
          }));
        },
      },
    ],
  });
  const { chooseChannel } = await import(bundled);

  // The change. It was a rule — an email address won, always — and a
  // customer with both never got a text.
  chk(
    "THE POINT: asked to text somebody who also has an email, it texts",
    chooseChannel({ channel: "text", customerEmail: "a@b.com" }).useEmail === false
  );
  chk(
    "asked to email, it emails",
    chooseChannel({ channel: "email", customerEmail: "a@b.com" }).useEmail === true
  );

  // The old precedence, kept as the default so a client that has not
  // reloaded still behaves the way it did yesterday.
  chk(
    "told nothing, an email address still wins",
    chooseChannel({ channel: null, customerEmail: "a@b.com" }).useEmail === true
  );
  chk(
    "told nothing with no address, it texts",
    chooseChannel({ channel: null, customerEmail: null }).wanted === "text"
  );

  // A stale form can ask for an email on a record that has none. Inventing
  // one is not an option, so it falls back to the link rather than failing.
  chk(
    "asked to email somebody with no address, it does not pretend",
    chooseChannel({ channel: "email", customerEmail: null }).useEmail === false
  );
  chk(
    "a nonsense channel falls back to the default, not to nothing",
    chooseChannel({ channel: "carrier pigeon", customerEmail: "a@b.com" }).useEmail === true
  );
}

writeFileSync(join(dir, "done"), "");
console.log(bad === 0 ? `\nall ${"ok"} — quoteService holds` : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
