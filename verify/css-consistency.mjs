// Every stylesheet in the app, checked against one type scale and one palette.
//
// The problem this exists to stop is not any single wrong value — it is drift.
// Before the scale there were 41 distinct font-sizes across 44 stylesheets,
// eight of them inside a single 0.14rem band all doing the same job, because
// each page was written on a different day and 0.85rem and 0.88rem look
// identical while you are writing them. Nobody chose that; it accumulated.
//
// So this does not check that the CSS is beautiful. It checks that a NEW
// one-off cannot be added without somebody noticing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";

// The customer-facing quote page is deliberately excluded. It shares no
// classes with the CRM — "a change to the app's chrome must never be able to
// alter what a customer sees" — and wiring it to the CRM's tokens would
// undo exactly that. It owns its own type scale.
const EXCLUDE = [/pages[\\/]quote[\\/]/];

function stylesheets(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) stylesheets(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

// Comments are stripped before anything is matched. A value written in a
// comment to explain a decision is documentation, not a declaration, and
// flagging it would teach people to stop writing the explanations.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const files = stylesheets(ROOT).filter((p) => !EXCLUDE.some((re) => re.test(p)));

// The scale itself, read from index.css rather than restated here — a copy
// would be one more thing to drift.
const tokens = [
  ...strip(readFileSync(join(ROOT, "index.css"), "utf8")).matchAll(
    /--text-([\w-]+)\s*:\s*([0-9.]+)rem/g
  ),
].map((m) => `--text-${m[1]}`);

let problems = [];
const note = (file, line, text) =>
  problems.push(`${relative(ROOT, file)}:${line}  ${text}`);

// The palette. Every colour used more than twice in the app as it stands,
// plus the greys and the blues it is built from. A new entry here should be a
// deliberate act, which is the point.
const PALETTE = new Set([
  // slate
  "#0f172a", "#1e293b", "#334155", "#475569", "#64748b", "#94a3b8",
  "#cbd5e1", "#e2e8f0", "#f1f5f9", "#f8fafc", "#ffffff",
  // blue — the brand
  "#1e40af", "#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd",
  "#bfdbfe", "#dbeafe", "#eff6ff",
  // green — paid, done, good
  "#052e16", "#14532d", "#166534", "#15803d", "#16a34a", "#22c55e",
  "#86efac", "#bbf7d0", "#dcfce7", "#f0fdf4",
  // amber — due, warning
  "#78350f", "#92400e", "#b45309", "#d97706", "#f59e0b", "#fbbf24",
  "#fcd34d", "#fde68a", "#fef3c7", "#fffbeb",
  // red — lost, failed, delete
  "#7f1d1d", "#991b1b", "#b91c1c", "#dc2626", "#ef4444",
  "#fca5a5", "#fecaca", "#fee2e2", "#fef2f2",
  // violet — commercial, and the "extra" job badge
  "#5b21b6", "#6d28d9", "#7c3aed", "#a78bfa", "#ddd6fe", "#f3e8ff", "#f5f3ff",
  // orange — upcoming
  "#7c2d12", "#9a3412", "#c2410c", "#ea580c", "#fed7aa", "#ffedd5", "#fff7ed",

  // Yellow, cyan and indigo appear in exactly one place: the eight status
  // chips on All leads. That looks like drift and is not — new, contacted,
  // quoted, booked, scheduled, completed, lost and archived each need to be
  // told apart at a glance, and eight statuses need eight hues. Collapsing
  // them into the four above would make three different statuses identical.
  "#fefce8", "#a16207",   // quoted
  "#ecfeff", "#0e7490",   // booked
  "#eef2ff", "#4338ca",   // scheduled

  // Google's own blue, for the you-are-here dot on the map. Deliberately not
  // the brand blue: it is the colour every phone user already reads as "this
  // is where you are", and matching Google Maps is the point.
  "#4285f4",
]);

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const lines = strip(raw).split("\n");

  lines.forEach((line, i) => {
    const n = i + 1;

    // A font-size must be a token. rem and px are both drift; em and % are
    // deliberately relative to a parent and are left alone.
    const size = line.match(/(?<![-\w])font-size:\s*([^;]+);/);
    if (size) {
      const v = size[1].trim();
      if (/^[0-9.]+(rem|px)$/.test(v)) {
        note(file, n, `font-size: ${v} — use a --text-* token (src/index.css)`);
      } else if (v.startsWith("var(")) {
        const name = v.match(/var\(\s*(--[\w-]+)/)?.[1];
        if (name && !tokens.includes(name)) {
          note(file, n, `font-size: ${v} — ${name} is not in the scale`);
        }
      }
    }

    // `white` and `#ffffff` are the same colour spelled two ways, which is
    // how a codebase ends up with both in the same file.
    if (/(?<![-\w])(color|background|background-color|border-color):\s*white\s*;/.test(line)) {
      note(file, n, "white — write #ffffff, one spelling");
    }

    // Any hex that is not in the palette. Shorthand is flagged too: #fff and
    // #ffffff are the same colour and a search for one will not find the other.
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = m[0].toLowerCase();
      if (hex.length === 4) {
        note(file, n, `${m[0]} — write the six-digit form`);
      } else if (hex.length === 7 && !PALETTE.has(hex)) {
        note(file, n, `${m[0]} — not in the palette (verify/css-consistency.mjs)`);
      }
    }
  });
}

console.log(`${files.length} stylesheets, ${tokens.length} steps in the scale`);

if (problems.length === 0) {
  console.log("\nthe app speaks with one voice");
} else {
  for (const p of problems) console.log(`  ${p}`);
  console.log(`\n${problems.length} inconsistenc${problems.length === 1 ? "y" : "ies"}`);
}

process.exitCode = problems.length === 0 ? 0 : 1;
