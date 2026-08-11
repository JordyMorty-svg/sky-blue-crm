import { useEffect, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

/**
 * Shows the user's current location as an always-visible blue dot using an
 * AdvancedMarker with custom HTML (fixed pixel size, so it stays visible at
 * any zoom). A translucent accuracy circle is drawn behind it.
 */
export default function UserLocation({ position, accuracy }) {
  const map = useMap();
  const markerLib = useMapsLibrary("marker");
  const mapsLib = useMapsLibrary("maps");
  const markerRef = useRef(null);
  const circleRef = useRef(null);

  // Accuracy halo (a real-world circle, fine to scale with zoom).
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

  // The blue dot — fixed pixel size via a custom HTML AdvancedMarker.
  useEffect(() => {
    if (!map || !markerLib || !position) return;

    if (!markerRef.current) {
      const dot = document.createElement("div");
      dot.style.width = "18px";
      dot.style.height = "18px";
      dot.style.borderRadius = "50%";
      dot.style.background = "#4285F4";
      dot.style.border = "3px solid #ffffff";
      dot.style.boxShadow = "0 0 0 1px rgba(66,133,244,0.5), 0 2px 6px rgba(0,0,0,0.3)";

      markerRef.current = new markerLib.AdvancedMarkerElement({
        map,
        position,
        content: dot,
        title: "You are here",
        zIndex: 9999,
      });
    } else {
      markerRef.current.position = position;
    }
  }, [map, markerLib, position]);

  useEffect(() => {
    return () => {
      if (markerRef.current) markerRef.current.map = null;
      if (circleRef.current) circleRef.current.setMap(null);
    };
  }, []);

  return null;
}