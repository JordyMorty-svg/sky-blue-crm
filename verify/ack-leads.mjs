// The acknowledgment sweep.
//
// verify/lead-ack.sql proves the database offers the right leads. This runs
// the function that acts on them, which is where the interesting failure
// was: the first draft called claim_sms() itself and THEN sendSms(), which
// claims again — the second claim hit the dedupe index, came back
// 'already_sent', and the text was never sent at all.
//
// Two functions that both work, composed into a feature that silently does
// nothing. No assertion on either one would have noticed; only running the
// sweep does.
//
// THE FUNCTION UNDER TEST IS NOT STUBBED. Only the database and the Quo and
// Resend edges are.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

const dir = mkdtempSync(join(tmpdir(), "ack-"));

// Stands in for PostgREST. Records every call, and — crucially — enforces
// the ONE rule the real dedupe index enforces: a second claim for the same
// lead fails. A stub that said yes twice would have hidden the bug above.
const DB_STUB = `
  globalThis.__calls = [];
  const claimed = new Set();

  export async function rpc(fn, args) {
    globalThis.__calls.push({ fn, args });

    if (fn === "sms_due_lead_acks") return globalThis.__due;

    if (fn === "claim_sms") {
      const key = \`\${args.p_kind}:\${args.p_lead_id}\`;
      if (claimed.has(key)) {
        return [{ id: null, ok: false, reason: "already_sent", phone: args.p_phone }];
      }
      claimed.add(key);
      return [{ id: claimed.size, ok: true, reason: "claimed", phone: args.p_phone }];
    }

    return [];
  }
  export const rpcQuietly = async (...a) => { try { return await rpc(...a); } catch { return null; } };
  export const supabaseHeaders = () => ({});
`;

const out = join(dir, "bundle.mjs");

await build({
  entryPoints: ["netlify/functions/ack-leads.mjs"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /lib\/db\.mjs$/ }, (a) => ({ path: a.path, namespace: "db" }));
        b.onLoad({ filter: /.*/, namespace: "db" }, () => ({ contents: DB_STUB, loader: "js" }));

        // The Quo and Resend edges. sms.mjs and email.mjs are real modules
        // with their own suites; what matters here is what the sweep asks
        // them to do.
        b.onResolve({ filter: /lib\/sms\.mjs$/ }, (a) => ({ path: a.path, namespace: "sms" }));
        b.onLoad({ filter: /.*/, namespace: "sms" }, () => ({
          contents: `
            import { rpc } from "./lib/db.mjs";
            export async function sendSms(args) {
              globalThis.__sms = globalThis.__sms || [];
              globalThis.__sms.push(args);
              // A genuinely throwing case. The first version of the
              // batch-resilience test used a lead with a null phone, which
              // did not throw at all — so deleting the try/catch left it
              // green. A test for "survives an exception" needs an
              // exception.
              if (args.phone === "+1THROW") throw new Error("Quo exploded");
              // Faithful: the REAL sendSms claims before sending, which is
              // the whole point. A stub that skipped the claim would hide a
              // caller that claimed first.
              const r = (await rpc("claim_sms", {
                p_kind: args.kind, p_phone: args.phone, p_body: args.body,
                p_lead_id: args.leadId, p_force: args.force,
              }))[0];
              if (!r.ok) return { ok: false, reason: r.reason };
              globalThis.__sent = (globalThis.__sent || 0) + 1;
              return { ok: true };
            }
            export const QUO_BASE = () => "https://example.invalid";`,
          loader: "js",
          resolveDir: process.cwd() + "/netlify",
        }));

        b.onResolve({ filter: /lib\/email\.mjs$/ }, (a) => ({ path: a.path, namespace: "mail" }));
        b.onLoad({ filter: /.*/, namespace: "mail" }, () => ({
          contents: `
            export async function sendEmail(args) {
              globalThis.__mail = globalThis.__mail || [];
              globalThis.__mail.push(args);
              return { ok: true };
            }`,
          loader: "js",
        }));
      },
    },
  ],
});

const mod = await import(out);

function reset(due) {
  globalThis.__due = due;
  globalThis.__calls = [];
  globalThis.__sms = [];
  globalThis.__mail = [];
  globalThis.__sent = 0;
}

const WANDA = {
  out_lead_id: "lead-1",
  out_name: "Wanda Pell",
  out_phone: "+15555550011",
  out_email: "wanda@example.com",
  out_has_sms: true,
};

const ELLIE = {
  out_lead_id: "lead-2",
  out_name: "Ellie",
  out_phone: null,
  out_email: "ellie@example.com",
  out_has_sms: false,
};

// --- the text actually goes ------------------------------------------------

reset([WANDA]);
await mod.default();

chk(
  "THE POINT: a due enquiry actually gets a text sent",
  globalThis.__sent === 1,
  "the first draft claimed twice and sent nothing — two working functions, " +
    "composed into a feature that did nothing at all"
);

chk(
  "and claim_sms is called exactly ONCE for it",
  globalThis.__calls.filter((c) => c.fn === "claim_sms").length === 1,
  `${globalThis.__calls.filter((c) => c.fn === "claim_sms").length} claims — ` +
    `sendSms claims internally, so claiming first makes its claim the second one`
);

const sms = globalThis.__sms[0];

chk("it goes to the number the database normalised", sms.phone === "+15555550011");
chk("tagged as an ack, so it dedupes and reads correctly in history", sms.kind === "ack");
chk("and carries the lead", sms.leadId === "lead-1");

chk(
  "THE POINT: quiet hours are bypassed for a reply to an inbound enquiry",
  sms.force === true,
  "they typed their number in sixty seconds ago; holding it until 9am is the " +
    "problem this exists to fix"
);

// --- what it says -----------------------------------------------------------

chk("it uses their first name only", /^Hi Wanda,/.test(sms.body), sms.body);
chk("it names the business, because the number is unknown to them",
  /Sky Blue Cleaning/.test(sms.body));
chk("it promises a person, not a price", /someone will contact you/i.test(sms.body));
chk(
  "it promises no price or timing of its own",
  !/\$|today|tomorrow|within \d/i.test(sms.body),
  "a wrong guess from a robot loses the job before anyone has spoken"
);
chk("and it is short enough not to arrive in four pieces", sms.body.length <= 320,
  `${sms.body.length} characters`);

// A lead with no name must not produce "Hi , thanks".
reset([{ ...WANDA, out_name: null }]);
await mod.default();
chk(
  "a nameless enquiry does not get 'Hi ,'",
  /^Thanks for reaching out/.test(globalThis.__sms[0].body),
  globalThis.__sms[0].body
);

// --- email fallback ---------------------------------------------------------

reset([ELLIE]);
await mod.default();

chk(
  "an enquiry with no phone is emailed instead of dropped",
  globalThis.__mail.length === 1 && globalThis.__mail[0].to === "ellie@example.com"
);
chk("and no text is attempted", globalThis.__sms.length === 0);
chk("the email is tagged 'ack' so it counts as answered", globalThis.__mail[0].kind === "ack");
chk("and carries the lead, so the next sweep can see it", globalThis.__mail[0].leadId === "lead-2");
chk(
  "it makes the same promise as the text",
  /someone will contact you/i.test(globalThis.__mail[0].text)
);

// --- one bad enquiry does not abandon the batch -----------------------------

reset([{ ...WANDA, out_phone: "+1THROW" }, ELLIE]);
await mod.default();

chk(
  "THE POINT: an enquiry that throws does not stop the rest of the sweep",
  globalThis.__mail.length === 1,
  "a scheduled pass that gives up on the first bad row catches up with nothing"
);

// --- nothing to do ----------------------------------------------------------

reset([]);
await mod.default();
chk(
  "an empty sweep sends nothing and raises nothing",
  globalThis.__sms.length === 0 && globalThis.__mail.length === 0
);

// --- the schedule -----------------------------------------------------------

chk(
  "it runs every minute, because the delay it honours is one minute",
  mod.config.schedule === "* * * * *",
  mod.config.schedule
);

console.log(bad === 0 ? "\nAcknowledgments hold" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
