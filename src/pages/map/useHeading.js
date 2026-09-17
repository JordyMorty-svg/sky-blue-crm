import { useCallback, useEffect, useRef, useState } from "react";
import { normaliseHeading, smoothHeading } from "./mapGeometry";

/**
 * Which way the phone is pointing.
 *
 * ---------------------------------------------------------------------------
 * Two sources, because neither one is enough on its own
 * ---------------------------------------------------------------------------
 *
 * 1. The COMPASS (DeviceOrientation). Works standing still, which is the case
 *    that matters — you're on a sidewalk deciding which house is which. But
 *    iOS 13+ refuses to emit these events until the page asks permission, and
 *    that request must come from a real user gesture or it throws.
 *
 * 2. COURSE OVER GROUND (GeolocationCoordinates.heading), which MapView
 *    already receives on every position update. Free, no permission, no
 *    prompt — but it is null whenever you aren't moving, because the
 *    direction of travel is undefined when there is no travel.
 *
 * So: prefer the compass when we have it, fall back to course when walking,
 * and show no direction at all rather than a wrong one when we have neither.
 *
 * ---------------------------------------------------------------------------
 * The permission
 * ---------------------------------------------------------------------------
 *
 * `request()` is exported for the caller to fire from inside an existing tap.
 * MapView hooks it onto the "Live tracking" button, so turning tracking on is
 * the gesture that unlocks the compass — no second button, no extra prompt
 * out of nowhere. On everything except iOS the listener attaches immediately
 * and `request()` is a no-op.
 */

const NEEDS_PERMISSION =
  typeof DeviceOrientationEvent !== "undefined" &&
  typeof DeviceOrientationEvent.requestPermission === "function";

export default function useHeading({ enabled, fallbackHeading }) {
  const [compass, setCompass] = useState(null);
  // iOS starts blocked; everywhere else there is nothing to grant.
  const [granted, setGranted] = useState(!NEEDS_PERMISSION);
  const smoothedRef = useRef(null);

  const request = useCallback(async () => {
    if (!NEEDS_PERMISSION) return true;
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      const ok = result === "granted";
      setGranted(ok);
      return ok;
    } catch (e) {
      // Thrown when called outside a user gesture, and on a denial in some
      // versions. Not worth surfacing — the arrow just falls back to course
      // over ground, which is the same thing it does on a laptop.
      console.warn("Compass permission unavailable:", e);
      setGranted(false);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !granted) return;
    if (typeof window === "undefined" || !window.addEventListener) return;

    function onOrientation(e) {
      // iOS gives a true compass bearing directly. Everywhere else `alpha` is
      // counter-clockwise from east-ish, so it has to be flipped to read as a
      // clockwise-from-north bearing.
      let deg;
      if (typeof e.webkitCompassHeading === "number") {
        deg = e.webkitCompassHeading;
      } else if (typeof e.alpha === "number") {
        deg = 360 - e.alpha;
      } else {
        return;
      }

      // `absolute` false means the reading drifts relative to wherever the
      // page started rather than to magnetic north. Better no arrow than one
      // confidently pointing the wrong way.
      if (e.absolute === false && typeof e.webkitCompassHeading !== "number") {
        return;
      }

      const next = smoothHeading(smoothedRef.current, deg);
      smoothedRef.current = next;
      setCompass(next);
    }

    // `deviceorientationabsolute` is the one that's actually earth-referenced
    // on Android; plain `deviceorientation` is the iOS path. Listening to both
    // and letting the handler sort it out is simpler than sniffing platforms.
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);

    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation, true);
      window.removeEventListener("deviceorientation", onOrientation, true);
    };
  }, [enabled, granted]);

  // Drop the smoothed bearing when tracking stops, so turning it back on in a
  // different place snaps to the new reading instead of easing round from a
  // stale one. Only the ref is cleared — `compass` is left alone and gated
  // out of the result below instead, because clearing state from inside an
  // effect just to hide it is a cascading render for nothing.
  useEffect(() => {
    if (!enabled) smoothedRef.current = null;
  }, [enabled]);

  // Not tracking means we genuinely don't know which way you're facing, and
  // saying so is better than pointing at wherever you last were.
  const heading = !enabled
    ? null
    : compass !== null
      ? compass
      : normaliseHeading(fallbackHeading);

  return { heading, request, compassAvailable: granted };
}
