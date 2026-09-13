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
        function builder(table) {
          const q = {
            _table: table,
            _eq: {},
            select(sel) { state.calls.push({ table, sel }); return q; },
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
