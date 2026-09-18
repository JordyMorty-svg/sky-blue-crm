import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Map, InfoWindow, useMap, useMapsLibrary, MapControl, ControlPosition } from "@vis.gl/react-google-maps";
import Pin from "./Pin";
import PinScale from "./PinScale";
import MapCapabilityCheck from "./MapCapabilityCheck";
import UserLocation from "./UserLocation";
import useHeading from "./useHeading";
import { fetchMapLeads, fetchMapCustomers } from "../../services/mapService";
import MapAddLeadModal from "./MapAddLeadModal";
import QuoteAfterCreate from "../../components/QuoteAfterCreate";
import { quotable } from "../../services/quoteService";
import { useAuth } from "../../context/useAuth";
import { canSee } from "../../components/capabilities";
import "./MapView.css";

// Evaluated once at module load — geolocation support never changes at
// runtime, so there's no reason to re-check it inside a render or effect.
const GEO_SUPPORTED =
  typeof navigator !== "undefined" && "geolocation" in navigator;

const DEFAULT_CENTER = { lat: 44.5646, lng: -123.262 };

/**
 * The Map ID, which is not optional.
 *
 * Every marker on this page — the lead pins and the blue "you are here" dot —
 * is an AdvancedMarkerElement, and those require a Map ID that really exists
 * in Google Cloud Console. Without one they don't render at all: no error, no
 * warning in the UI, just an empty map.
 *
 * This used to be the string "skyblue_crm_map" hardcoded here. If that was
 * never registered, nothing was ever going to appear.
 *
 * DEMO_MAP_ID is Google's own public testing ID. It keeps the map working
 * out of the box, but it is explicitly for development — hence the notice
 * the page shows while it's in use. Set VITE_GOOGLE_MAPS_MAP_ID to a real
 * one and the notice goes away.
 */
const DEMO_MAP_ID = "DEMO_MAP_ID";
const MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || DEMO_MAP_ID;

const STATUS_COLORS = {
  new: "#94a3b8",
  contacted: "#eab308",
  quoted: "#2563eb",
  booked: "#86efac",
  scheduled: "#f97316",
  completed: "#16a34a",
  none: "#94a3b8",
};

const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
  scheduled: "Scheduled",
  completed: "Completed",
  none: "No status",
};

// Recenters the map on the user when the signal changes. Zooms in on the
// first locate, then just pans (so following doesn't fight your zoom).
function RecenterOnUser({ position, signal }) {
  const map = useMap();
  const zoomedRef = useRef(false);
  useEffect(() => {
    if (map && position && signal > 0) {
      map.panTo(position);
      if (!zoomedRef.current) {
        map.setZoom(16);
        zoomedRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
  return null;
}

function customerStatus(customer) {
  const jobs = customer.jobs || [];
  if (jobs.some((j) => j.status === "scheduled")) return "scheduled";
  if (jobs.some((j) => j.status === "completed")) return "completed";
  return "none";
}

// Handles map clicks when "add mode" is on: reverse-geocodes the clicked
// point and hands back { lat, lng, address }.
function ClickToAdd({ active, onPicked }) {
  const map = useMap();
  const geocodingLib = useMapsLibrary("geocoding");
  // Derived from the library, not independent state — a useState/useEffect
  // pair here just causes an extra render for a value we can compute.
  const geocoder = useMemo(
    () => (geocodingLib ? new geocodingLib.Geocoder() : null),
    [geocodingLib]
  );

  useEffect(() => {
    if (!map || !active) return;

    const listener = map.addListener("click", (e) => {
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();

      if (geocoder) {
        geocoder.geocode({ location: { lat, lng } }, (results, status) => {
          const address =
            status === "OK" && results?.[0] ? results[0].formatted_address : "";
          onPicked({ lat, lng, address });
        });
      } else {
        onPicked({ lat, lng, address: "" });
      }
    });

    return () => listener.remove();
  }, [map, active, geocoder, onPicked]);

  return null;
}

export default function MapView() {
  const navigate = useNavigate();
  // A partner has no customer pages, so a customer pin would be a marker
  // that bounces them back to Leads when tapped. The map they get is the
  // lead map, which is the one they came for anyway.
  const { role } = useAuth();
  const showCustomers = canSee(role, "customer-detail");
  const [pins, setPins] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addMode, setAddMode] = useState(false);
  const [newLeadLocation, setNewLeadLocation] = useState(null); // {lat,lng,address}
  // The lead just created from a pin, held so the quote can be offered
  // against it. Null the rest of the time.
  const [quoting, setQuoting] = useState(null);

  const [userPos, setUserPos] = useState(null); // {lat,lng}
  const [accuracy, setAccuracy] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [recenterSignal, setRecenterSignal] = useState(0); // bump to recenter
  // Null until the map reports back. Distinguished from `true`/`false` so the
  // warning doesn't flash on screen during the moment before we know.
  const [markersOk, setMarkersOk] = useState(null);
  // Course over ground, straight off the GPS fix. Null whenever you aren't
  // moving — useHeading prefers the compass and only falls back to this.
  const [gpsHeading, setGpsHeading] = useState(null);

  const { heading, request: requestCompass } = useHeading({
    enabled: tracking,
    fallbackHeading: gpsHeading,
  });

  // `showCustomers` is in the deps rather than an empty array. The profile —
  // and so the role — resolves a beat after the session does, so the first
  // load runs under the default role. Without a refetch when the real role
  // lands, a partner would see the whole customer base plotted until
  // something else happened to reload the map.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCustomers]);

  async function load() {
    try {
      setLoading(true);
      const [leads, customers] = await Promise.all([
        fetchMapLeads(),
        fetchMapCustomers(),
      ]);

      const leadPins = leads.map((l) => ({
        key: `lead-${l.id}`,
        id: l.id,
        kind: "lead",
        name: l.name,
        address: l.address,
        status: l.status,
        position: { lat: Number(l.latitude), lng: Number(l.longitude) },
      }));

      const customerPins = customers.map((c) => ({
        key: `customer-${c.id}`,
        id: c.id,
        kind: "customer",
        name: c.name,
        address: c.address,
        status: customerStatus(c),
        position: { lat: Number(c.latitude), lng: Number(c.longitude) },
      }));

      setPins(showCustomers ? [...leadPins, ...customerPins] : leadPins);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load the map.");
    } finally {
      setLoading(false);
    }
  }

  const handlePicked = useCallback((loc) => {
    setNewLeadLocation(loc);
    setAddMode(false); // exit add mode once a spot is picked
  }, []);

  // One-time "find me" — gets current position and recenters.
  function locateOnce() {
    if (!navigator.geolocation) {
      setError("Location isn't available on this device/browser.");
      return;
    }
    const onOk = (pos) => {
      setError("");
      setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setAccuracy(pos.coords.accuracy);
      setRecenterSignal((n) => n + 1);
    };
    // Try GPS first; if it times out (common on desktop), retry rougher.
    navigator.geolocation.getCurrentPosition(
      onOk,
      () => {
        navigator.geolocation.getCurrentPosition(
          onOk,
          (err) => {
            console.error(err);
            setError(
              err.code === 1
                ? "Location permission was denied. Enable it in your browser settings."
                : "Couldn't get your location. (Desktop often can't — try your phone.)"
            );
          },
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // Live tracking — watch position as the user moves. Support is checked
  // in toggleTracking rather than here: setting state synchronously inside
  // an effect triggers a second render pass, and the check doesn't need to
  // wait for the effect anyway.
  useEffect(() => {
    if (!tracking || !GEO_SUPPORTED) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setError("");
        setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
        setGpsHeading(pos.coords.heading);
        setRecenterSignal((n) => n + 1); // follow me
      },
      (err) => {
        console.error(err);
        setError(
          err.code === 1
            ? "Location permission was denied. Enable it in your browser settings."
            : "Couldn't track your location. (Desktop often can't — try your phone.)"
        );
        setTracking(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [tracking]);

  function toggleTracking() {
    if (!tracking && !GEO_SUPPORTED) {
      setError("Location isn't available on this device/browser.");
      return;
    }
    setTracking((t) => {
      const next = !t;
      if (next) {
        setRecenterSignal((n) => n + 1); // center when turning on
        // iOS only emits compass events after an explicit grant, and that
        // request has to originate in a user gesture — this tap is one. Doing
        // it here rather than behind its own button means the arrow just
        // works from the moment tracking starts, with no second prompt
        // appearing out of nowhere. Deliberately not awaited: a denial is
        // fine, the arrow falls back to course over ground.
        void requestCompass();
      }
      return next;
    });
  }

  function goToRecord(pin) {
    navigate(pin.kind === "lead" ? `/leads/${pin.id}` : `/customers/${pin.id}`);
  }

  function handleCreated(lead) {
    setNewLeadLocation(null);
    load(); // refresh pins to show the new lead

    // The map is where this matters most. A pin dropped at a door, quoted on
    // the spot, is the whole reason the map has an Add lead form — and until
    // now it was the one path that saved the price and then left the quote
    // unsent. Same offer as the New lead page, same component.
    if (quotable(lead)) setQuoting(lead);
  }

  if (loading) return <div className="mapview__state">Loading map…</div>;

  return (
    <div className="mapview">
      {error && <p className="mapview__error">{error}</p>}

      {/* The silent-failure guard. An unregistered Map ID draws a perfectly
          healthy-looking map with nothing on it, so the page has to say so
          itself — there is nothing in the UI to notice otherwise. */}
      {markersOk === false && (
        <p className="mapview__warn">
          <b>Pins can&rsquo;t render.</b> Google needs a valid Map ID for map
          markers, and <code>{MAP_ID}</code> isn&rsquo;t registered to this
          project. Create one in Google Cloud Console under{" "}
          <b>Google Maps Platform → Map Management</b>, then set{" "}
          <code>VITE_GOOGLE_MAPS_MAP_ID</code> and redeploy.
        </p>
      )}

      {markersOk !== false && MAP_ID === DEMO_MAP_ID && (
        <p className="mapview__note">
          Running on Google&rsquo;s shared demo Map ID. Fine for now — create
          your own in Cloud Console and set{" "}
          <code>VITE_GOOGLE_MAPS_MAP_ID</code> before this matters.
        </p>
      )}

      <div className="mapview__legend">
        {Object.keys(STATUS_LABELS).map((key) => (
          <span className="mapview__legend-item" key={key}>
            <span className="mapview__dot" style={{ background: STATUS_COLORS[key] }} />
            {STATUS_LABELS[key]}
          </span>
        ))}
      </div>

      <div className={`mapview__map ${addMode ? "mapview__map--adding" : ""}`}>
        <Map
          mapId={MAP_ID}
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={13}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <MapCapabilityCheck onChange={setMarkersOk} />
          {pins.map((pin) => {
            const color = STATUS_COLORS[pin.status] || STATUS_COLORS.none;
            return (
              <Pin
                key={pin.key}
                position={pin.position}
                color={color}
                title={pin.name}
                selected={selected?.key === pin.key}
                clickable={!addMode}
                onClick={() => !addMode && setSelected(pin)}
              />
            );
          })}

          {/* Publishes --pin-size to the map container. Must be inside <Map>
              so it can reach the map instance. Renders nothing. */}
          <PinScale />

          <ClickToAdd active={addMode} onPicked={handlePicked} />

          {userPos && (
            <UserLocation position={userPos} accuracy={accuracy} heading={heading} />
          )}
          <RecenterOnUser position={userPos} signal={recenterSignal} />

          <MapControl position={ControlPosition.TOP_RIGHT}>
            <button
              className={`mapview__addbtn ${addMode ? "mapview__addbtn--active" : ""}`}
              onClick={() => setAddMode((m) => !m)}
            >
              {addMode ? (
                <>
                  <span className="mapview__addbtn-dot" />
                  Click a house to place it
                </>
              ) : (
                <>+ Add lead by location</>
              )}
            </button>
          </MapControl>

          <MapControl position={ControlPosition.RIGHT_BOTTOM}>
            <div className="mapview__loc-controls">
              <button
                className="mapview__loc-btn"
                onClick={locateOnce}
                title="Find my location"
              >
                ◎ My location
              </button>
              <button
                className={`mapview__loc-btn ${tracking ? "mapview__loc-btn--tracking" : ""}`}
                onClick={toggleTracking}
                title="Follow my location as I move"
              >
                {tracking ? "● Tracking on" : "○ Live tracking"}
              </button>
            </div>
          </MapControl>

          {selected && !addMode && (
            <InfoWindow
              position={selected.position}
              onCloseClick={() => setSelected(null)}
            >
              <div className="mapview__info">
                <strong>{selected.name}</strong>
                <span>{selected.address}</span>
                <span className="mapview__info-status">
                  {STATUS_LABELS[selected.status] || selected.status}
                </span>
                <button className="mapview__info-link" onClick={() => goToRecord(selected)}>
                  View {selected.kind}
                </button>
              </div>
            </InfoWindow>
          )}
        </Map>
      </div>

      {newLeadLocation && (
        <MapAddLeadModal
          location={newLeadLocation}
          onClose={() => setNewLeadLocation(null)}
          onCreated={handleCreated}
        />
      )}

      {/* Closing returns to the map rather than navigating anywhere: the pin
          is already on it, and the lead is saved either way. */}
      <QuoteAfterCreate lead={quoting} onDone={() => setQuoting(null)} />
    </div>
  );
}