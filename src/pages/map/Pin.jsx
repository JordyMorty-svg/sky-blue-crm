import { useEffect, useRef } from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";

/**
 * One lead or customer on the map.
 *
 * An AdvancedMarker with plain HTML content rather than a google.maps.Circle.
 * The difference matters: a Circle's radius is in METRES, so it shrinks to
 * nothing as you zoom out (see mapGeometry.js for the numbers). HTML content
 * is sized in pixels and stays legible at every zoom.
 *
 * The size itself is NOT set here. It comes from the `--pin-size` CSS custom
 * property, which PinScale writes once onto the map container whenever the
 * zoom changes. Fifty pins then resize from a single style write instead of
 * fifty React re-renders — worth doing, because zoom fires continuously
 * through a pinch gesture.
 */
export default function Pin({
  position,
  color,
  title,
  selected = false,
  clickable = true,
  onClick,
}) {
  const map = useMap();
  const markerLib = useMapsLibrary("marker");
  const markerRef = useRef(null);
  const dotRef = useRef(null);
  // Held in a ref so changing the handler doesn't tear down and rebuild the
  // marker — which would make every pin flicker on each parent render.
  // Written in an effect rather than during render: a ref mutation in the
  // render body is read-during-render territory and React will warn. The
  // click can only happen after effects have run, so this is early enough.
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onClickRef.current = onClick;
  }, [onClick]);

  // Create once.
  //
  // Every visual property is applied HERE as well as in its own effect below,
  // and that duplication is the whole point. `markerLib` is null on the first
  // render or two while the maps library loads, so this effect bails out and
  // `dotRef` stays null. The style effects run, find no node, and skip. When
  // the library finally resolves, THIS effect re-runs and builds the node —
  // but the style effects don't, because their own dependencies never
  // changed.
  //
  // That is exactly what shipped: every pin was created with no background,
  // so they rendered as transparent circles with a faint white ring. Present
  // on the map, and invisible on it.
  useEffect(() => {
    if (!map || !markerLib) return;

    const hit = document.createElement("div");
    hit.className = "mappin";

    const dot = document.createElement("div");
    dot.className = "mappin__dot";
    // The line whose absence caused the bug.
    dot.style.background = color;
    if (selected) dot.classList.add("mappin__dot--selected");
    hit.style.pointerEvents = clickable ? "auto" : "none";
    hit.appendChild(dot);
    dotRef.current = dot;

    const marker = new markerLib.AdvancedMarkerElement({
      map,
      position,
      content: hit,
      title: title || "",
    });
    marker.gmpClickable = clickable;
    marker.zIndex = selected ? 900 : 1;
    markerRef.current = marker;

    const listener = marker.addListener("gmp-click", () => {
      onClickRef.current?.();
    });

    return () => {
      listener.remove();
      marker.map = null;
      markerRef.current = null;
      dotRef.current = null;
    };
    // Deliberately only [map, markerLib]. The other props are read above to
    // seed the initial state and are then kept current by the effects below;
    // listing them here would tear down and rebuild the marker — losing the
    // click listener — every time a lead changed colour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, markerLib]);

  useEffect(() => {
    if (markerRef.current) markerRef.current.position = position;
  }, [position]);

  useEffect(() => {
    if (dotRef.current) dotRef.current.style.background = color;
  }, [color]);

  useEffect(() => {
    if (!dotRef.current) return;
    dotRef.current.classList.toggle("mappin__dot--selected", selected);
    // Lift the open one above its neighbours so the ring isn't half-hidden
    // under the pin next door.
    if (markerRef.current) markerRef.current.zIndex = selected ? 900 : 1;
  }, [selected]);

  useEffect(() => {
    if (!markerRef.current) return;
    // gmpClickable is what actually gates hit-testing on an AdvancedMarker;
    // pointer-events alone would still let the map's own click-to-add fire
    // underneath and drop a new lead on top of an existing one.
    markerRef.current.gmpClickable = clickable;
    if (markerRef.current.content) {
      markerRef.current.content.style.pointerEvents = clickable ? "auto" : "none";
    }
  }, [clickable]);

  return null;
}
