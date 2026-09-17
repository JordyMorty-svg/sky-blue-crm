/**
 * The bug: a pin that renders with no colour.
 *
 * `useMapsLibrary("marker")` returns null for the first render or two while
 * Google's library loads. Pin's creation effect bails out during that window,
 * so the DOM node doesn't exist yet — and the effects that apply colour,
 * selection and clickability run, find nothing, and quietly do nothing.
 *
 * When the library resolves, the creation effect re-runs and builds the node.
 * The style effects do NOT, because their own dependencies never changed. The
 * pin is added to the map with no background: a transparent circle with a
 * faint white ring. On the map, and invisible on it.
 *
 * That is not a Google problem or a CSS problem, which is where two rounds of
 * debugging went. It is an effect-ordering problem, and this is the test that
 * would have caught it in the first place.
 */
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Pin from "../src/pages/map/Pin.jsx";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

const POS = { lat: 44.5646, lng: -123.262 };

function mount(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (p) =>
    act(() => {
      root.render(
        <StrictMode>
          <Pin {...p} />
        </StrictMode>
      );
    });
  render(props);
  return {
    render,
    done: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const fake = globalThis.__mapsFake;

// --- 1. The regression ----------------------------------------------------
//
// Start with the library unavailable, exactly as it is on a cold load.

fake.setLibrary(null);
let pin = mount({ position: POS, color: "#16a34a", title: "Dennehy", clickable: true });

check(
  "no marker while the maps library is still loading",
  fake.markers.length === 0,
  `${fake.markers.length} created too early`
);

// Library resolves. This is the moment the real bug happened.
act(() => fake.setLibrary(fake.lib));

check("marker is created once the library lands", fake.markers.length === 1);

const created = fake.live();
const dot = created.content?.querySelector(".mappin__dot");

check("the pin has a dot element", !!dot);
check(
  "THE BUG: the dot has its colour, not a transparent background",
  dot && dot.style.background !== "",
  `background was "${dot ? dot.style.background : "(no dot)"}"`
);
check(
  "...and it is the right colour",
  dot && /16a34a|22,\s*163,\s*74/i.test(dot.style.background),
  dot ? dot.style.background : "(no dot)"
);

check("position is set", created.position === POS);
check("title carries through for the tooltip", created.title === "Dennehy");
check("clickable by default", created.gmpClickable === true);

pin.done();

// --- 2. The same hazard for every other visual prop -----------------------
//
// Colour was the one that shipped, but selection and clickability are applied
// by the same pattern and would fail the same way.

fake.reset();
fake.setLibrary(null);
pin = mount({ position: POS, color: "#2563eb", selected: true, clickable: false });
act(() => fake.setLibrary(fake.lib));

const late = fake.live();
const lateDot = late.content?.querySelector(".mappin__dot");

check(
  "a pin created while already selected shows as selected",
  lateDot && lateDot.classList.contains("mappin__dot--selected"),
  lateDot ? lateDot.className : "(no dot)"
);
check(
  "a pin created while add-mode is on is not clickable",
  late.gmpClickable === false,
  String(late.gmpClickable)
);
check("a selected pin is lifted above its neighbours", late.zIndex === 900);
pin.done();

// --- 3. Normal updates still work ----------------------------------------

fake.reset();
fake.setLibrary(fake.lib);
pin = mount({ position: POS, color: "#eab308", selected: false, clickable: true });

const live = fake.live();
const liveDot = live.content.querySelector(".mappin__dot");
check("library ready at mount still colours the dot",
  /eab308|234,\s*179,\s*8/i.test(liveDot.style.background), liveDot.style.background);

const before = fake.markers.length;
pin.render({ position: POS, color: "#f97316", selected: true, clickable: true });
check("a colour change updates in place",
  /f97316|249,\s*115,\s*22/i.test(liveDot.style.background), liveDot.style.background);
check("selecting it adds the ring", liveDot.classList.contains("mappin__dot--selected"));
check(
  "none of that rebuilt the marker — the click listener survives",
  fake.markers.length === before,
  `went from ${before} to ${fake.markers.length}`
);

// Moving a lead must not rebuild it either.
const moved = { lat: 44.57, lng: -123.27 };
pin.render({ position: moved, color: "#f97316", selected: true, clickable: true });
check("moving a pin repositions rather than recreates",
  live.position === moved && fake.markers.length === before);

pin.done();
check("unmounting takes the marker off the map", live.map === null);

// --- 4. Clicks ------------------------------------------------------------

fake.reset();
fake.setLibrary(fake.lib);
let clicks = 0;
pin = mount({ position: POS, color: "#94a3b8", onClick: () => clicks++ });
act(() => fake.live().fire("gmp-click"));
check("a tap opens the lead", clicks === 1, `fired ${clicks} times`);

// Swapping the handler must not lose the listener — this is why it lives in
// a ref rather than in the creation effect's dependencies.
pin.render({ position: POS, color: "#94a3b8", onClick: () => (clicks += 10) });
act(() => fake.live().fire("gmp-click"));
check("a new handler is picked up without rebuilding", clicks === 11, `clicks=${clicks}`);
pin.done();

// --- report ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  — " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
