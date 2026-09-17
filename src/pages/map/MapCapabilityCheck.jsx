import { useEffect } from "react";
import { useMap } from "@vis.gl/react-google-maps";

/**
 * Asks the map what it can actually do, and tells the page.
 *
 * Advanced Markers — which every pin and the "you are here" dot are built
 * from — require a Map ID that is genuinely registered in Google Cloud
 * Console. Google's own wording: "Advanced markers requires a map ID. If the
 * map ID is missing, advanced markers cannot load."
 *
 * The failure mode is the problem. There is no exception, no red console
 * error, no missing-image placeholder. The markers are simply never drawn,
 * and the map looks perfectly healthy with nothing on it. That cost an
 * afternoon once; this component exists so it can't cost another one.
 *
 * `mapcapabilities_changed` is the supported way to ask. The answer isn't
 * available synchronously at mount — the map has to hear back about the Map
 * ID first — so the current value is read once and then on every change.
 */
export default function MapCapabilityCheck({ onChange }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    function read() {
      const caps = map.getMapCapabilities?.();
      // Undefined means an API version old enough not to have the call at
      // all. Treating that as "fine" is right: those versions predate the
      // Map ID requirement, so the markers work anyway.
      onChange(caps ? caps.isAdvancedMarkersAvailable !== false : true);
    }

    read();
    const listener = map.addListener("mapcapabilities_changed", read);
    return () => listener.remove();
  }, [map, onChange]);

  return null;
}
