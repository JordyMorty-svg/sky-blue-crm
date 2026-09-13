// Runs the real TaxExport page and the real taxService against a fake
// Supabase, in jsdom.
//
// Only the network layer is stubbed. The PostgREST query chain, the table
// names, the embedded-select shapes and the `.eq("status", "paid")` filter
// are all real code paths — so if the payouts query ever stopped filtering
// on paid, or the jobs query asked for a column that isn't selected, it
// fails here rather than in a CSV handed to an accountant.
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
    b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
      contents: `
        const state = { jobs: [], commissions: [], calls: [] };

        // The real schema. PostgREST returns a 400 for a column that does
        // not exist, and the page turns that into "Couldn't load the year's
        // figures" — so a stub that cheerfully ignores the select string
        // lets a typo'd or imagined column pass every test and fail in
        // production. It did exactly that once: taxService asked for
        // jobs.address, which lives on leads and customers instead.
        const SCHEMA = {
          jobs: {
            cols: ["id","lead_id","customer_id","price","final_price","paid",
                   "payment_method","starts_at","duration_hours","notes","status",
                   "service_plan","property_type","visit_number","is_extra",
                   "service_keys"],
            rels: { lead: "leads", customer: "customers" },
          },
          commissions: {
            cols: ["id","profile_id","lead_id","job_id","kind","rate","base_amount",
                   "amount","status","earned_at","payable_at","paid_at","note",
                   "reversal_of"],
            rels: { profile: "profiles", lead: "leads", job: "jobs" },
          },
          leads: { cols: ["id","name","address","phone","email","status","estimate"], rels: {} },
          customers: { cols: ["id","name","address","phone","email"], rels: {} },
          profiles: { cols: ["id","full_name","role","active","commission_eligible"], rels: {} },
        };

        // Split a select list on commas that are not inside parentheses.
        function topLevel(sel) {
          const out = []; let depth = 0, cur = "";
          for (const ch of sel) {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
            cur += ch;
          }
          if (cur.trim()) out.push(cur);
          return out.map((s) => s.trim()).filter(Boolean);
        }

        function validate(table, sel) {
          const spec = SCHEMA[table];
          if (!spec) throw new Error("fake supabase: no schema for table " + table);
          for (const part of topLevel(sel)) {
            const open = part.indexOf("(");
            if (open === -1) {
              const col = part.split(":").pop().trim();
              if (col !== "*" && !spec.cols.includes(col)) {
                throw new Error(
                  'column "' + col + '" does not exist on ' + table +
                  ' — PostgREST would return 400 here'
                );
              }
              continue;
            }
            // An embed: "alias:fk ( inner, cols )" or "relation ( inner )".
            const head = part.slice(0, open).trim();
            const alias = head.split(":")[0].trim();
            const target = spec.rels[alias];
            if (!target) {
              throw new Error(
                'no relationship "' + alias + '" from ' + table + " — PostgREST would return 400"
              );
            }
            validate(target, part.slice(open + 1, part.lastIndexOf(")")));
          }
        }

        function builder(table) {
          const q = {
            _table: table,
            _eq: {},
            select(sel) { validate(table, sel); state.calls.push({ table, sel }); return q; },
            order() { return q; },
            in() { return q; },
            eq(col, val) { q._eq[col] = val; return q; },
            then(res) {
              let data;
              if (table === "jobs") {
                data = state.jobs;
                // Mirror the real filter, so a page that forgot .eq on
                // status would see rows it shouldn't.
                if (q._eq.status) data = data.filter((r) => (r.status ?? "completed") === q._eq.status);
              } else if (table === "commissions") {
                data = state.commissions;
                if (q._eq.status) data = data.filter((r) => r.status === q._eq.status);
              } else {
                data = [];
              }
              return Promise.resolve({ data, error: null }).then(res);
            },
          };
          return q;
        }
        export const supabase = {
          from: (t) => builder(t),
          rpc: () => Promise.resolve({ data: null, error: null }),
        };
        globalThis.__supabaseFake = {
          __setJobs: (r) => { state.jobs = r; },
          __setCommissions: (r) => { state.commissions = r; },
          __calls: state.calls,
        };
      `,
      loader: "js",
      resolveDir: process.cwd(),
    }));
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
  },
};

await build({
  entryPoints: ["verify/tax.test.jsx"],
  bundle: true,
  outfile: "verify/.tax.mjs",
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [stub],
  logLevel: "warning",
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://crm.example.com/",
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MouseEvent = dom.window.MouseEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

global.Blob = dom.window.Blob;
// The service calls the bare global `URL`, which in a browser IS window.URL.
// Node's own URL is a different object with a createObjectURL that rejects
// jsdom's Blob, so point the global at jsdom's — that also makes the test's
// `window.URL.createObjectURL = ...` capture actually take effect.
global.URL = dom.window.URL;

const realError = console.error;
console.error = (...a) => {
  if (typeof a[0] === "string" && a[0].includes("not wrapped in act")) return;
  realError(...a);
};

await import("./.tax.mjs");
