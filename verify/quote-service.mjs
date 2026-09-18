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
  fetchQuotes,
  quoteState,
  smsHref,
  smsText,
  money,
  shortDate,
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

writeFileSync(join(dir, "done"), "");
console.log(bad === 0 ? `\nall ${"ok"} — quoteService holds` : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
