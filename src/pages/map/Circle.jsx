import { useEffect, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

/**
 * A clickable colored circle overlay. Wraps google.maps.Circle since the
 * library doesn't always export a ready-made Circle component.
 */
export function Circle({
  center,
  radius,
  strokeColor,
  strokeOpacity = 1,
  strokeWeight = 2,
  fillColor,
  fillOpacity = 0.5,
  clickable = true,
  onClick,
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const circleRef = useRef(null);

  useEffect(() => {
    if (!map || !mapsLib) return;

    const circle = new mapsLib.Circle({
      map,
      center,
      radius,
      strokeColor,
      strokeOpacity,
      strokeWeight,
      fillColor,
      fillOpacity,
      clickable,
    });
    circleRef.current = circle;

    let listener;
    if (onClick) {
      listener = circle.addListener("click", onClick);
    }

    return () => {
      if (listener) listener.remove();
      circle.setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapsLib, center.lat, center.lng, radius, fillColor, strokeColor]);

  return null;
}