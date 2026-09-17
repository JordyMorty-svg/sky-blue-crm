// Renders the real pin and arrow markup, with the real CSS, in Chromium.
//
// The unit tests prove the numbers. This proves you can see the thing — which
// is the entire point of the change, and not something a number can tell you.
// The DOM built here mirrors exactly what Pin.jsx and UserLocation.jsx create
// at runtime, and the sizes come from the real pinSizeForZoom rather than
// being typed in.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { pinSizeForZoom, hitSizeForZoom } from "../src/pages/map/mapGeometry.js";

const css = readFileSync("src/pages/map/MapView.css", "utf8");

const STATUS_COLORS = {
  new: "#94a3b8",
  contacted: "#eab308",
  quoted: "#2563eb",
  booked: "#86efac",
  scheduled: "#f97316",
  completed: "#16a34a",
};

const ZOOMS = [11, 13, 15, 17, 19];

// Two grounds, because the pins have to read against both: Google's default
// pale roadmap, and satellite imagery. A pale pin with no ring vanishes on
// one; a dark one vanishes on the other.
const GROUNDS = [
  { name: "roadmap", bg: "#e8eaed", label: "#5f6368" },
  { name: "satellite", bg: "#3d4a36", label: "#d7dcd3" },
];

function pinRow(zoom) {
  const dots = Object.entries(STATUS_COLORS)
    .map(
      ([status, color], i) =>
        `<div class="mappin" title="${status}">
           <div class="mappin__dot${i === 3 ? " mappin__dot--selected" : ""}"
                style="background:${color}"></div>
         </div>`
    )
    .join("");
  return `
    <div class="row" style="--pin-size:${pinSizeForZoom(zoom)}px;--pin-hit:${hitSizeForZoom(zoom)}px">
      <div class="rowlabel">zoom ${zoom}<br><span>${pinSizeForZoom(zoom)}px</span></div>
      <div class="dots">${dots}</div>
    </div>`;
}

// Headings chosen to catch a transform-origin mistake: if the cone rotated
// about its own centre instead of its tip, 180° would sit visibly off the dot.
const HEADINGS = [0, 45, 90, 180, 270, 315];

function arrowRow() {
  const arrows = HEADINGS.map(
    (h) => `
      <div class="arrowcell">
        <div class="userloc">
          <div class="userloc__cone" style="opacity:1;transform:translate(-50%,-100%) rotate(${h}deg)"></div>
          <div class="userloc__dot"></div>
        </div>
        <span>${h}°</span>
      </div>`
  ).join("");
  // The last cell is the no-heading case: standing still, no compass. The cone
  // must be absent, not pointing at a stale bearing.
  return `<div class="arrows">${arrows}
      <div class="arrowcell">
        <div class="userloc">
          <div class="userloc__cone"></div>
          <div class="userloc__dot"></div>
        </div>
        <span>none</span>
      </div>
    </div>`;
}

for (const ground of GROUNDS) {
  const html = `<!doctype html><meta charset=utf-8><style>
    ${css}
    body{margin:0;background:${ground.bg};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:28px}
    h2{color:${ground.label};font-size:14px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.08em}
    .row{display:flex;align-items:center;gap:20px;margin-bottom:6px;min-height:46px}
    .rowlabel{width:74px;font-size:12px;color:${ground.label};font-weight:700;line-height:1.35}
    .rowlabel span{font-weight:400;opacity:.75}
    .dots{display:flex;align-items:center;gap:26px}
    .arrows{display:flex;gap:44px;align-items:flex-end;margin-top:8px}
    .arrowcell{display:flex;flex-direction:column;align-items:center;gap:26px}
    .arrowcell > span{font-size:12px;color:${ground.label};font-weight:600}
    .sep{height:26px}
  </style>
  <h2>Pins — ${ground.name}</h2>
  ${ZOOMS.map(pinRow).join("")}
  <div class="sep"></div>
  <h2>Heading arrow</h2>
  ${arrowRow()}`;

  writeFileSync(`verify/.map-${ground.name}.html`, html);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const ground of GROUNDS) {
  const page = await browser.newPage({
    viewport: { width: 700, height: 560 },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${process.cwd()}/verify/.map-${ground.name}.html`);
  await page.waitForTimeout(250);

  // Measure what actually rendered, rather than trusting that the CSS applied.
  // A typo in a custom property name fails silently and falls back to the
  // default — which would look fine here and be wrong in the app.
  const measured = await page.$$eval(".row", (rows) =>
    rows.map((row) => {
      const dot = row.querySelector(".mappin__dot");
      const hit = row.querySelector(".mappin");
      return {
        label: row.querySelector(".rowlabel").textContent.trim().split("\n")[0],
        dot: Math.round(dot.getBoundingClientRect().width),
        hit: Math.round(hit.getBoundingClientRect().width),
      };
    })
  );
  console.log(`${ground.name}:`, JSON.stringify(measured));

  for (const [i, zoom] of ZOOMS.entries()) {
    const expected = pinSizeForZoom(zoom);
    if (measured[i].dot !== expected) {
      console.error(
        `FAIL zoom ${zoom}: rendered ${measured[i].dot}px, expected ${expected}px`
      );
      process.exitCode = 1;
    }
  }

  await page.screenshot({ path: `verify/shot-map-${ground.name}.png`, fullPage: true });
  await page.close();
}
await browser.close();
console.log("shots written");
