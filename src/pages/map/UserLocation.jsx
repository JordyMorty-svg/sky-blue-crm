import { useEffect, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

/**
 * Where you are, and — when we know it — which way you're facing.
 *
 * Three layers, back to front:
 *
 *   1. The accuracy halo. A real google.maps.Circle, because this one IS a
 *      real-world measurement: GPS says "within 20 metres" and 20 metres is
 *      what should be drawn. It's the one circle on this map that correctly
 *      shrinks as you zoom out.
 *   2. The heading cone, when a heading is available.
 *   3. The blue dot, in fixed pixels.
 *
 * The map itself stays north-up. Rotating the whole map with the compass is
 * the other way to do this, but it needs a vector Map ID and it spins every
 * street label with it, which people find harder to read rather than easier.
 * An arrow answers "which way am I pointing" without moving the world.
 */
export default function UserLocation({ position, accuracy, heading }) {
  const map = useMap();
  const markerLib = useMapsLibrary("marker");
  const mapsLib = useMapsLibrary("maps");
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const coneRef = useRef(null);

  // Accuracy halo (a real-world circle, correct to scale with zoom).
  useEffect(() => {
    if (!map || !mapsLib || !position) return;
    if (!circleRef.current) {
      circleRef.current = new mapsLib.Circle({
        map,
        fillColor: "#4285F4",
        fillOpacity: 0.12,
        strokeColor: "#4285F4",
        strokeOpacity: 0.25,
        strokeWeight: 1,
        clickable: false,
      });
    }
    circleRef.current.setCenter(position);
    circleRef.current.setRadius(accuracy || 30);
  }, [map, mapsLib, position, accuracy]);

  // The dot and its cone — fixed pixel size via a custom HTML AdvancedMarker.
  useEffect(() => {
    if (!map || !markerLib || !position) return;

    if (!markerRef.current) {
      const wrap = document.createElement("div");
      wrap.className = "userloc";

      // Drawn first so it sits behind the dot in paint order.
      const cone = document.createElement("div");
      cone.className = "userloc__cone";
      wrap.appendChild(cone);
      coneRef.current = cone;

      const dot = document.createElement("div");
      dot.className = "userloc__dot";
      wrap.appendChild(dot);

      markerRef.current = new markerLib.AdvancedMarkerElement({
        map,
        position,
        content: wrap,
        title: "You are here",
        zIndex: 9999,
      });
    } else {
      markerRef.current.position = position;
    }
  }, [map, markerLib, position]);

  // Point the cone. Written straight to the DOM node rather than through
  // React state: the compass updates many times a second, and a transform is
  // a compositor-only change that costs nothing. Re-rendering a component at
  // that rate to move one triangle would not be free.
  useEffect(() => {
    const cone = coneRef.current;
    if (!cone) return;

    if (heading === null || heading === undefined) {
      // No heading is a real answer — standing still with no compass. Hide
      // the cone rather than leaving it pointing at the last known bearing,
      // which would be a confident lie.
      cone.style.opacity = "0";
      return;
    }

    cone.style.opacity = "1";
    cone.style.transform = `translate(-50%, -100%) rotate(${heading}deg)`;
  }, [heading]);

  useEffect(() => {
    return () => {
      if (markerRef.current) markerRef.current.map = null;
      if (circleRef.current) circleRef.current.setMap(null);
      markerRef.current = null;
      circleRef.current = null;
      coneRef.current = null;
    };
  }, []);

  return null;
}
