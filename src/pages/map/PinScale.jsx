import { useEffect } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import { hitSizeForZoom, pinSizeForZoom } from "./mapGeometry";

/**
 * Publishes the current pin size to CSS.
 *
 * Every pin is sized in `var(--pin-size)`. This watches the map's zoom and
 * writes that one variable onto the map's own container element, which is an
 * ancestor of every AdvancedMarker's content — so the custom property
 * inherits down to all of them.
 *
 * The alternative was passing `zoom` into every Pin as a prop, which means
 * re-rendering every marker on every zoom change. Zoom fires continuously
 * through a pinch, and with fifty leads on screen that's fifty component
 * updates per frame. This is one style write per frame instead, and the
 * pins resize in the compositor.
 *
 * Renders nothing.
 */
export default function PinScale() {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    const root = map.getDiv();
    if (!root) return;

    let frame = null;

    function apply() {
      frame = null;
      const zoom = map.getZoom();
      root.style.setProperty("--pin-size", `${pinSizeForZoom(zoom)}px`);
      root.style.setProperty("--pin-hit", `${hitSizeForZoom(zoom)}px`);
    }

    // Coalesced to one write per animation frame. A pinch emits zoom_changed
    // far faster than the screen refreshes, and setProperty on every one of
    // them is wasted layout work.
    function schedule() {
      if (frame === null) frame = requestAnimationFrame(apply);
    }

    apply(); // set it before the first pin paints, not a frame later
    const listener = map.addListener("zoom_changed", schedule);

    return () => {
      listener.remove();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [map]);

  return null;
}
