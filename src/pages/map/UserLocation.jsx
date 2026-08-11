import { useEffect, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

/**
 * Shows the user's current location as a blue dot on the map.
 *
 * Props:
 *   position   — { lat, lng } or null
 *   accuracy   — accuracy radius in meters (optional)
 */
export default function UserLocation({ position, accuracy }) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const markerRef = useRef(null);
  const circleRef = useRef(null);

  useEffect(() => {
    if (!map || !mapsLib || !position) return;

    // The accuracy halo.
    if (!circleRef.current) {
      circleRef.current = new mapsLib.Circle({
        map,
        fillColor: "#4285F4",
        fillOpacity: 0.15,
        strokeColor: "#4285F4",
        strokeOpacity: 0.3,
        strokeWeight: 1,
        clickable: false,
      });
    }
    circleRef.current.setCenter(position);
    circleRef.current.setRadius(accuracy || 30);

    // The blue dot itself (a small solid circle).
    if (!markerRef.current) {
      markerRef.current = new mapsLib.Circle({
        map,
        fillColor: "#4285F4",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeOpacity: 1,
        strokeWeight: 3,
        clickable: false,
        radius: 8,
      });
    }
    markerRef.current.setCenter(position);

    return () => {};
  }, [map, mapsLib, position, accuracy]);

  // Clean up overlays on unmount.
  useEffect(() => {
    return () => {
      if (markerRef.current) markerRef.current.setMap(null);
      if (circleRef.current) circleRef.current.setMap(null);
    };
  }, []);

  return null;
}