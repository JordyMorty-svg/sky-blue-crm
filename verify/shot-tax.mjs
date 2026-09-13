// Renders the real TaxExport page in Chromium and photographs it.
//
// The jsdom suite proves the numbers; this proves you can read them. Two
// widths, because the twelve-month strip and the rep table are the two
// things most likely to fall apart on a phone.
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const TRE = "33333333-3333-3333-3333-333333333333";
const SAM = "55555555-5555-5555-5555-555555555555";

// A plausible year: busier in summer, one job finished and never collected,
// and two reps either side of the $600 line.
const JOBS = [];
const SHAPE = [4, 5, 7, 9, 12, 15, 18, 17, 11, 8, 5, 4];
let n = 0;
for (let m = 0; m < 12; m++) {
  for (let i = 0; i < SHAPE[m]; i++) {
    n++;
    const price = [420, 550, 600, 675, 750, 900][n % 6];
    JOBS.push({
      id: `j${n}`,
      starts_at: new Date(2026, m, 2 + ((i * 2) % 26), 10).toISOString(),
      status: "completed",
      paid: !(m === 8 && i === 0),
      price,
      final_price: n % 7 === 0 ? price + 120 : price,
      payment_method: n % 3 === 0 ? "cash" : "card",
      visit_number: (n % 3) + 1,
      service_plan: n % 4 === 0 ? "quarterly" : "one_time",
      property_type: n % 9 === 0 ? "commercial" : "residential",
      address: `${100 + n} NW Monroe Ave, Corvallis OR`,
      customer: { name: ["Dennehy Residence", "Okonkwo Storefront", "Blythe Utz", "Marisol Vance", "Prescott Duplex"][n % 5], address: null },
      lead: null,
    });
  }
}

const COMMISSIONS = [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({
    id: `t${i}`, kind: ["find", "book", "work"][i % 3], rate: [15, 10, 20][i % 3],
    base_amount: 750, amount: [112.5, 75, 150][i % 3], status: "paid",
    earned_at: new Date(2026, i + 1, 3).toISOString(),
    paid_at: new Date(2026, i + 1, 10).toISOString(),
    note: null, reversal_of: null,
    profile: { id: TRE, full_name: "Trenton Hale", role: "partner" },
    lead: { name: "Blythe Utz" },
    job: { starts_at: new Date(2026, i + 1, 3).toISOString(), visit_number: 1, customer: { name: "Blythe Utz" } },
  })),
  { id: "s1", kind: "work", rate: 20, base_amount: 1600, amount: 320, status: "paid",
    earned_at: new Date(2026, 5, 1).toISOString(), paid_at: new Date(2026, 5, 8).toISOString(),
    note: null, reversal_of: null,
    profile: { id: SAM, full_name: "Sam Ruiz", role: "tech" },
    lead: null,
    job: { starts_at: new Date(2026, 5, 1).toISOString(), visit_number: 2, customer: { name: "Okonkwo Storefront" } } },
];

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /supabaseClient$/ }, (a) => ({ path: a.path, namespace: "sb" }));
    b.onLoad({ filter: /.*/, namespace: "sb" }, () => ({
      contents: `const JOBS = ${JSON.stringify(JOBS)}; const COMM = ${JSON.stringify(COMMISSIONS)};
        function q(t){const o={select:()=>o,order:()=>o,in:()=>o,eq:()=>o,
          then:(r)=>Promise.resolve({data: t==="jobs"?JOBS:COMM, error:null}).then(r)};return o;}
        export const supabase = { from:(t)=>q(t), rpc:()=>Promise.resolve({data:null,error:null}) };`,
      loader: "js", resolveDir: process.cwd(),
    }));
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
    b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  },
};

writeFileSync("verify/.tax-entry.jsx", `
  import { createRoot } from "react-dom/client";
  import { MemoryRouter } from "react-router-dom";
  import { AuthContext } from "../src/context/auth-context";
  import TaxExport from "../src/pages/income/TaxExport";
  const v = { session:{user:{id:"u1"}}, user:{id:"u1",email:"jordan@skybluecleaningco.com"},
    profile:{full_name:"Jordan Mortensen",role:"admin"}, role:"admin", isAdmin:true,
    isTech:false, loading:false, signOut(){} };
  createRoot(document.getElementById("root")).render(
    <AuthContext.Provider value={v}>
      <MemoryRouter initialEntries={["/income/tax"]}><TaxExport /></MemoryRouter>
    </AuthContext.Provider>);
`);

await build({
  entryPoints: ["verify/.tax-entry.jsx"], bundle: true, outfile: "verify/.tax-page.js",
  format: "iife", jsx: "automatic", plugins: [stub], logLevel: "warning",
});

// index.css carries .visually-hidden. Without it the harness shows headings
// the real app hides, and the screenshot lies about the layout.
const css = ["src/index.css", "src/pages/income/TaxExport.css", "src/components/ViewSwitcher.css"]
  .map((f) => readFileSync(f, "utf8")).join("\n");
writeFileSync("verify/.tax-page.html", `<!doctype html><meta charset=utf-8>
<style>${readFileSync("src/App.css", "utf8")}\n${css}
body{margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px}</style>
<div id=root></div><script>${readFileSync("verify/.tax-page.js", "utf8")}</script>`);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const w of [1100, 390]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`file://${process.cwd()}/verify/.tax-page.html`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `verify/shot-tax-${w}.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log("shots written");
