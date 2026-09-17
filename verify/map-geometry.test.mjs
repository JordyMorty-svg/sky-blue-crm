/**
 * The pin sizing curve and the compass maths.
 *
 * The bug this whole change exists to fix was a UNIT confusion — a radius in
 * metres read as if it were pixels — so the tests that matter most are the
 * ones pinning actual pixel values at actual zoom levels. A future refactor
 * that quietly reintroduces a ground-referenced size will fail here.
 */
import {
  MAX_PIN,
  MIN_PIN,
  headingDelta,
  hitSizeForZoom,
  normaliseHeading,
  pinSizeForZoom,
  smoothHeading,
} from "../src/pages/map/mapGeometry.js";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

// --- 1. The regression this replaces -------------------------------------
//
// google.maps.Circle with radius 7 rendered these pixel radii in Corvallis:
//   zoom 13 → 0.51px   zoom 14 → 1.03px   zoom 16 → 4.11px
// The map's default zoom is 13. Whatever the curve does, it must never again
// produce something you cannot see.

for (const zoom of [8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21]) {
  const size = pinSizeForZoom(zoom);
  check(
    `zoom ${zoom} pin is visible (${size}px)`,
    size >= MIN_PIN,
    `got ${size}px, floor is ${MIN_PIN}`
  );
}

check(
  "at the map's default zoom the pin is a real size, not half a pixel",
  pinSizeForZoom(13) >= 12,
  `${pinSizeForZoom(13)}px`
);

// --- 2. The curve itself --------------------------------------------------

check("clamped at the bottom", pinSizeForZoom(3) === MIN_PIN && pinSizeForZoom(12) === MIN_PIN);
check("clamped at the top", pinSizeForZoom(20) === MAX_PIN && pinSizeForZoom(30) === MAX_PIN);
check(
  "grows with zoom in between",
  pinSizeForZoom(13) < pinSizeForZoom(15) && pinSizeForZoom(15) < pinSizeForZoom(18),
  `${pinSizeForZoom(13)} / ${pinSizeForZoom(15)} / ${pinSizeForZoom(18)}`
);
check(
  "monotonic across the whole range — never shrinks as you zoom in",
  (() => {
    for (let z = 1; z < 24; z++) {
      if (pinSizeForZoom(z + 1) < pinSizeForZoom(z)) return false;
    }
    return true;
  })()
);
check("always a whole pixel", Number.isInteger(pinSizeForZoom(14.37)));
check(
  "fractional zooms work — pinch gestures report them",
  pinSizeForZoom(14.5) >= pinSizeForZoom(14) && pinSizeForZoom(14.5) <= pinSizeForZoom(15)
);

// Google reports no zoom until the map is ready. An undefined zoom must not
// become a NaN width, which in CSS collapses the pin to nothing — exactly the
// bug being fixed, reintroduced by a different route.
for (const bad of [undefined, null, NaN, "16", {}]) {
  const size = pinSizeForZoom(bad);
  check(
    `a ${String(bad)} zoom still gives a usable size`,
    Number.isFinite(size) && size >= MIN_PIN && size <= MAX_PIN,
    `got ${size}`
  );
}

// --- 3. Tap targets -------------------------------------------------------

check(
  "the hit area is always bigger than the dot",
  [10, 13, 16, 19].every((z) => hitSizeForZoom(z) > pinSizeForZoom(z))
);
check(
  "...but not so big that neighbouring pins overlap at low zoom",
  hitSizeForZoom(12) <= 30,
  `${hitSizeForZoom(12)}px`
);

// --- 4. Heading normalisation --------------------------------------------

check("a plain bearing passes through", normaliseHeading(90) === 90);
check("wraps past a full turn", normaliseHeading(370) === 10);
check("negatives come back positive", normaliseHeading(-90) === 270);
check("360 is 0, not 360", normaliseHeading(360) === 0);

// Both sources genuinely produce these. coords.heading is null whenever the
// device isn't moving; the compass reports NaN before it settles.
check("null stays null — standing still has no course", normaliseHeading(null) === null);
check("undefined stays null", normaliseHeading(undefined) === null);
check("NaN stays null rather than becoming a bearing", normaliseHeading(NaN) === null);

// --- 5. The short way round ----------------------------------------------
//
// Without this the arrow spins three quarters of a circle every time you
// walk past north.

check("350° → 10° is a 20° turn right", headingDelta(350, 10) === 20);
check("10° → 350° is a 20° turn left", headingDelta(10, 350) === -20);
check("no turn is zero", headingDelta(180, 180) === 0);
check(
  "never takes the long way",
  (() => {
    for (let a = 0; a < 360; a += 7) {
      for (let b = 0; b < 360; b += 11) {
        if (Math.abs(headingDelta(a, b)) > 180) return false;
      }
    }
    return true;
  })()
);

// --- 6. Smoothing ---------------------------------------------------------

check("the first reading is taken as-is, no easing in from zero", smoothHeading(null, 270) === 270);
check("a null reading leaves the arrow where it was", smoothHeading(90, null) === 90);
check(
  "moves toward the target, not all the way",
  (() => {
    const out = smoothHeading(0, 100, 0.15);
    return out > 0 && out < 100;
  })(),
  String(smoothHeading(0, 100, 0.15))
);

// The boundary case. Smoothing 350 toward 10 must pass through 0, not swing
// back down through 180.
const acrossNorth = smoothHeading(350, 10, 0.5);
check(
  "smoothing across north goes the short way",
  acrossNorth >= 355 || acrossNorth <= 5,
  `landed on ${acrossNorth}`
);

check(
  "converges on the target rather than orbiting it",
  (() => {
    let h = 0;
    for (let i = 0; i < 200; i++) h = smoothHeading(h, 120);
    return Math.abs(h - 120) < 1;
  })(),
  (() => {
    let h = 0;
    for (let i = 0; i < 200; i++) h = smoothHeading(h, 120);
    return String(h);
  })()
);

check(
  "output is always a legal bearing",
  (() => {
    let h = null;
    for (const r of [350, 10, -40, 400, 180, 0, 359.9]) {
      h = smoothHeading(h, r);
      if (h === null || h < 0 || h >= 360) return false;
    }
    return true;
  })()
);

// --- report ---------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  — " + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
