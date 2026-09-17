/**
 * How big a map pin should be, in screen pixels, at a given zoom.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 *
 * The pins used to be `google.maps.Circle` with `radius={7}`. That radius is
 * SEVEN METRES ON THE GROUND, not seven pixels — so the pins were drawn at a
 * real-world size and shrank as you zoomed out. In Corvallis (lat 44.56):
 *
 *     zoom 13  →  0.51 px radius   ← the map's own default zoom
 *     zoom 14  →  1.03 px
 *     zoom 16  →  4.11 px
 *     zoom 18  →  16.45 px
 *
 * So at the zoom the map opens on, every lead was rendered about half a pixel
 * across. Not "small" — invisible. They only appeared once you'd zoomed most
 * of the way in, which is exactly the reported symptom.
 *
 * A pin marks a place; it does not have a size in metres. So it belongs in
 * pixels, which is what an AdvancedMarker with HTML content gives us — the
 * same thing UserLocation was already doing correctly for the blue dot.
 *
 * ---------------------------------------------------------------------------
 * Why it still varies with zoom
 * ---------------------------------------------------------------------------
 *
 * Fixed pixels would fix the vanishing, but a single size can't serve both
 * ends of the range:
 *
 *   - Zoomed out over the whole town, dozens of pins are on screen. Big dots
 *     merge into an unreadable blob.
 *   - Zoomed into one street, there might be three, and you're tapping them
 *     with a thumb while standing on a porch.
 *
 * So the size grows with zoom, clamped at both ends. Small enough to stay
 * distinct across a city, large enough to hit with a finger up close.
 */

// The zoom at which the pin is at its smallest. Below this it stays put —
// past about zoom 11 you're looking at the whole county and a smaller dot
// wouldn't be visible anyway.
const BASE_ZOOM = 12;

// Pixels of diameter added per zoom level past BASE_ZOOM.
const GROWTH = 2.2;

export const MIN_PIN = 12; // never smaller than this — the old bug's floor
export const MAX_PIN = 26; // past this they start covering the houses

export function pinSizeForZoom(zoom) {
  // A missing or nonsense zoom means "we don't know yet" — the middle of the
  // range is a better guess than either extreme, and it means the first
  // paint before the map reports its zoom is never an invisible pin.
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return 16;

  const raw = MIN_PIN + (zoom - BASE_ZOOM) * GROWTH;
  return Math.round(Math.min(MAX_PIN, Math.max(MIN_PIN, raw)));
}

/**
 * The tap target around a pin.
 *
 * Apple asks for 44px and they're right about thumbs, but a 44px target on a
 * 12px pin means four neighbouring houses overlap each other's hit areas at
 * low zoom and you open the wrong lead. So the padding is fixed and modest:
 * comfortably bigger than the dot, never so big that adjacent pins fight.
 */
export const HIT_PADDING = 12;

export function hitSizeForZoom(zoom) {
  return pinSizeForZoom(zoom) + HIT_PADDING;
}

/**
 * Normalise a compass heading to 0–359.999, or null if there isn't one.
 *
 * Both sources can hand us something unusable. `GeolocationCoordinates.heading`
 * is null whenever the device isn't moving — course over ground is undefined
 * when you're standing still — and DeviceOrientation can report NaN before
 * the compass settles. Callers want one answer to "which way are we facing,
 * if we know", so the messiness is dealt with once, here.
 */
export function normaliseHeading(deg) {
  if (deg === null || deg === undefined) return null;
  const n = Number(deg);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

/**
 * The shorter way round between two headings, in degrees, signed.
 *
 * Used to stop the arrow spinning the long way round when the compass crosses
 * north: going from 350° to 10° is +20°, not -340°. Without this the arrow
 * whips through three quarters of a circle every time you face north.
 */
export function headingDelta(from, to) {
  const diff = ((to - from + 540) % 360) - 180;
  return diff;
}

/**
 * Smooth a noisy compass.
 *
 * A phone compass jitters by several degrees even lying still on a table, and
 * an arrow that twitches reads as broken. This is a simple exponential
 * smoother applied along the SHORT way round, so it doesn't lurch at the
 * 359→0 boundary.
 *
 * `factor` is how much of the new reading to take: 1 is no smoothing, 0.15 is
 * calm but still responsive enough to feel live when you turn on the spot.
 */
export function smoothHeading(previous, next, factor = 0.15) {
  const target = normaliseHeading(next);
  if (target === null) return previous;
  if (previous === null) return target; // first reading, snap to it
  return normaliseHeading(previous + headingDelta(previous, target) * factor);
}
