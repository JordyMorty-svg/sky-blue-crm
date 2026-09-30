// A re-export is not an import.
//
//     export { rpc } from "./db.mjs";     ← forwards the name onward
//     import { rpc } from "./db.mjs";     ← puts it in THIS file's scope
//
// The first one looks like it does both. It doesn't. Any local call to rpc()
// in a file that only re-exports it throws
//
//     ReferenceError: rpc is not defined
//
// at runtime — not at build, not at lint, and not in any test that stubs the
// module rather than running it.
//
// This shipped TWICE in one afternoon. First in sms-inbound.mjs, where
// verify/sms-js.mjs caught it because that suite calls the real webhook
// handler. Then in followUps.mjs, where nothing caught it, because every
// suite that touches follow-ups STUBS followUps.mjs at bundle time — so the
// broken binding was never executed. Jordan found it by pressing "Send
// review request" in the CRM and getting the raw ReferenceError in a red box.
//
// That is the whole lesson: a test that stubs the module under test cannot
// see a bug in the module under test. This file reads the source instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    console.log(`FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
    bad += 1;
  }
};

/** Every .mjs under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".mjs") || name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Comments and strings stripped, so a name mentioned in prose — and these
// files are more prose than code — can't be mistaken for a call.
//
// One character-by-character pass, not a stack of five .replace() calls.
// I wrote the .replace() version first and it silently ate two thirds of
// followUps.mjs, INCLUDING the very line this check exists to find, because
// /"(?:[^"\\]|\\.)*"/ has no newline guard: one unpaired quote anywhere and
// the match runs to the next quote a hundred lines down.
//
// It reported "Bindings hold" on a file I had deliberately re-broken. A
// check that passes on the known bug is worse than no check, because now
// nobody looks. Hence the scanner, and hence the self-test at the bottom.
function code(src) {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue; // leave the newline; line numbers and ^ anchors survive
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote + quote; // an empty string, so the syntax around it holds
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i += 1; // skip whatever is escaped
        else if (src[i] === "\n" && quote !== "`") break; // unterminated: bail
        i += 1;
      }
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * Names this source re-exports but does not import, while calling them.
 *
 * Each one is a ReferenceError waiting for somebody to press the button.
 */
export function offences(raw) {
  const src = code(raw);

  // export { a, b as c } from "..."
  const reExports = [...src.matchAll(/export\s*{([^}]*)}\s*from\s*['"`]/g)];
  if (reExports.length === 0) return [];

  // What the file imports normally — those names ARE in scope.
  const imported = new Set();
  for (const m of src.matchAll(/import\s*{([^}]*)}\s*from\s*['"`]/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  }

  // The re-export statements themselves mention the names; take them out
  // before looking for uses, or every re-export looks like a use of itself.
  let body = src;
  for (const m of reExports) body = body.replace(m[0], " ");

  const found = [];
  for (const m of reExports) {
    for (const part of m[1].split(",")) {
      // `export { a as b } from` forwards `a`; the local name would be `a`.
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (!local || local === "default" || !/^[A-Za-z_$][\w$]*$/.test(local)) continue;
      if (imported.has(local)) continue; // also imported — in scope, fine

      // Called, or read as a value. Both throw.
      const called = new RegExp(`\\b${local}\\s*\\(`).test(body);
      const read = new RegExp(`(?:await|[=,([:?]|\\breturn)\\s*${local}\\b`).test(body);

      if (called || read) found.push(local);
    }
  }
  return found;
}

// --- the check checks itself ------------------------------------------------
//
// Not ceremony. The first version of this file reported "Bindings hold" on a
// copy of followUps.mjs I had deliberately re-broken, and I only found out
// because I re-broke it on purpose before trusting the green. These four
// fixtures are that mutation test, run every time, so the next person to
// touch the scanner finds out the same way I did instead of shipping it.

const SELF = [
  [
    "catches a re-exported name that is called",
    `export { rpc } from "./db.mjs";\nasync function go() { return rpc("x"); }`,
    ["rpc"],
  ],
  [
    "allows a name that is imported as well as re-exported",
    `import { rpc } from "./db.mjs";\nexport { rpc };\nasync function go() { return rpc("x"); }`,
    [],
  ],
  [
    "allows a pure forward that the file never uses",
    `export { rpc } from "./db.mjs";\nexport const n = 1;`,
    [],
  ],
  [
    "is not fooled by an unbalanced quote earlier in the file",
    `const s = "it's fine";\n// don't\nexport { rpc } from "./db.mjs";\nconst v = rpc();`,
    ["rpc"],
  ],
];

for (const [what, src, want] of SELF) {
  const got = offences(src);
  chk(`self-test: ${what}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
}

// --- the real thing ---------------------------------------------------------

const files = [...walk("netlify"), ...walk("src")];
chk("there are modules to check", files.length > 20, `${files.length} found`);

for (const file of files) {
  for (const name of offences(readFileSync(file, "utf8"))) {
    chk(
      `${file} — ${name} is in scope where it is used`,
      false,
      `re-exported but never imported, and used locally. ` +
        `Add: import { ${name} } from "..."; export { ${name} };`
    );
  }
}

console.log(bad === 0 ? `\nBindings hold (${files.length} modules)` : `\n${bad} failure(s)`);
process.exitCode = bad === 0 ? 0 : 1;
