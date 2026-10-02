// Closing a quote, from the client side.
//
// verify/quote-close.sql proves the database refuses what it should. This
// covers the half it cannot see:
//
//   * the four reason codes the app offers are the four the CHECK constraint
//     accepts — a code the UI offers and the database refuses produces an
//     error from the far side of a save button, which is the worst possible
//     place to discover a typo;
//   * which endings are FINAL agrees between JS and SQL, because that is
//     what decides whether a Reopen button appears at all; and
//   * the panel prompts for a reason instead of closing blind.
//
// The modules under test are not stubbed. Only supabaseClient is.

import { build } from "esbuild";
import { readFileSync, mkdtempSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "qcj-"));
const out = join(dir, "bundle.mjs");

await build({
  entryPoints: ["src/services/quoteService.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
  plugins: [
    {
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
        b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
          contents:
            "export const supabase = { rpc: async (fn, args) => { globalThis.__rpc = { fn, args }; return { data: null, error: null }; } };",
          loader: "js",
        }));
      },
    },
  ],
});

const { CLOSE_REASONS, closeReason, reopenable, closeQuote, quoteState } =
  await import(out);

// --- the app and the database agree about the vocabulary --------------------

const sql = readFileSync("db/quote-close.sql", "utf8");

const constraintCodes = [
  ...(sql
    .match(/or closed_reason in \(([^)]*)\)/s)?.[1]
    .matchAll(/'([a-z_]+)'/g) ?? []),
].map((m) => m[1]);

const jsCodes = CLOSE_REASONS.map((r) => r.key);

chk(
  "the database defines four reason codes",
  constraintCodes.length === 4,
  constraintCodes.join(", ")
);

chk(
  "THE POINT: every reason the app offers is one the database accepts",
  jsCodes.every((k) => constraintCodes.includes(k)),
  `app has ${jsCodes.filter((k) => !constraintCodes.includes(k)).join(", ") || "none extra"}`
);

chk(
  "and every reason the database accepts is offered",
  constraintCodes.every((k) => jsCodes.includes(k)),
  `database has ${constraintCodes.filter((k) => !jsCodes.includes(k)).join(", ") || "none extra"} that the app never shows`
);

// --- which endings are final ------------------------------------------------

const sqlFinal = [
  ...(sql
    .match(/sb_quote_ending_is_final[\s\S]*?in \(([^)]*)\)/)?.[1]
    .matchAll(/'([a-z_]+)'/g) ?? []),
].map((m) => m[1]);

const jsFinal = CLOSE_REASONS.filter((r) => r.final).map((r) => r.key);

chk(
  "THE POINT: JS and SQL agree on which endings are final",
  JSON.stringify([...jsFinal].sort()) === JSON.stringify([...sqlFinal].sort()),
  `js=[${jsFinal}] sql=[${sqlFinal}] — the database refuses, the UI decides ` +
    `whether to offer the button, and a disagreement means a button that errors`
);

chk(
  "the work having been done is a final ending",
  closeReason("done_elsewhere").final === true,
  "Jeff's $1,800 was done inside the $3,280 job — there is nothing to reopen"
);

chk(
  "a re-quote is a final ending too",
  closeReason("requoted").final === true,
  "reopening it would put two live quotes in front of the same customer"
);

chk(
  "going quiet is NOT final",
  closeReason("no_response").final === false &&
    closeReason("went_elsewhere").final === false,
  "they might ring in March"
);

// --- wins and losses --------------------------------------------------------

chk(
  "THE POINT: work done on another job counts as a WIN",
  closeReason("done_elsewhere").win === true,
  "filing it with 'never heard back' counts a win as a loss in every " +
    "conversion number you ever look at"
);

chk(
  "and nothing else does",
  CLOSE_REASONS.filter((r) => r.win).length === 1
);

chk(
  "a re-quote is neither a win nor a loss",
  closeReason("requoted").win === false,
  "nobody turned anything down; the number was wrong"
);

// --- reopenable() -----------------------------------------------------------

chk(
  "a quote that is not closed is not reopenable",
  reopenable({ status: "sent" }) === false
);

chk(
  "THE POINT: a quote closed because the work was done offers no Reopen",
  reopenable({ status: "closed", closed_reason: "done_elsewhere" }) === false
);

chk(
  "one that simply went quiet does",
  reopenable({ status: "closed", closed_reason: "no_response" }) === true
);

chk(
  "and an unrecognised reason is treated as reopenable rather than stuck",
  reopenable({ status: "closed", closed_reason: null }) === true,
  "a row closed before the reasons existed must not become unreachable"
);

// --- the call itself --------------------------------------------------------

await closeQuote("q1", "done_elsewhere", { jobId: "job-9" });
chk(
  "closing sends the reason and the job",
  globalThis.__rpc.fn === "close_quote" &&
    globalThis.__rpc.args.p_reason === "done_elsewhere" &&
    globalThis.__rpc.args.p_job_id === "job-9"
);

await closeQuote("q1", "no_response");
chk(
  "and sends no job when there isn't one",
  globalThis.__rpc.args.p_job_id === null,
  "undefined would be dropped from the JSON body and the RPC would see no argument"
);

// --- the badge --------------------------------------------------------------

chk(
  "a closed quote reads as Closed, not Expired",
  quoteState({ status: "closed", expires_at: "2020-01-01" }).key === "closed",
  "a quote we withdrew in July does not become 'Expired' in August — that " +
    "loses who ended it and why"
);

// --- the panel prompts ------------------------------------------------------

const panel = readFileSync("src/components/QuotesPanel.jsx", "utf8");

chk(
  "THE POINT: the panel asks how it ended instead of closing blind",
  /How did this quote end\?/.test(panel) && /CLOSE_REASONS\.map/.test(panel),
  "'Closed' with no why throws away the only interesting thing about it"
);

chk(
  "Close it stays disabled until a reason is picked",
  /disabled=\{closing \|\| !reason\}/.test(panel)
);

chk(
  "the job picker only appears for the ending that means a job exists",
  /chosen\?\.asksForJob && jobs\.length > 0/.test(panel)
);

chk(
  "a final ending renders no Reopen button at all",
  /canReopen \? \(/.test(panel) && /quoterow__settled/.test(panel),
  "a disabled button invites the question instead of answering it"
);

chk(
  "a closed quote loses Text / Copy / Preview",
  /!isClosed &&\s*\(state\.key === "sent"/.test(panel),
  "texting a link that now refuses to be accepted is worse than sending nothing"
);

console.log(bad === 0 ? "\nClosing holds" : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
