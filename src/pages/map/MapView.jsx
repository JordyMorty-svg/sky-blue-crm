import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Map, InfoWindow, useMap, useMapsLibrary, MapControl, ControlPosition } from "@vis.gl/react-google-maps";
import { Circle } from "./Circle.jsx";
import UserLocation from "./UserLocation";
import { fetchMapLeads, fetchMapCustomers } from "../../services/mapService";
import MapAddLeadModal from "./MapAddLeadModal";
import "./MapView.css";

const DEFAULT_CENTER = { lat: 44.5646, lng: -123.262 };

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

// Recenters the map on the user when the signal changes.
function RecenterOnUser({ position, signal }) {
  const map = useMap();
  useEffect(() => {
    if (map && position && signal > 0) {
      map.panTo(position);
      map.setZoom(16);
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
  const [geocoder, setGeocoder] = useState(null);

  useEffect(() => {
    if (geocodingLib) setGeocoder(new geocodingLib.Geocoder());
  }, [geocodingLib]);

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
  const [pins, setPins] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addMode, setAddMode] = useState(false);
  const [newLeadLocation, setNewLeadLocation] = useState(null); // {lat,lng,address}

  const [userPos, setUserPos] = useState(null); // {lat,lng}
  const [accuracy, setAccuracy] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [recenterSignal, setRecenterSignal] = useState(0); // bump to recenter

  useEffect(() => {
    load();
  }, []);

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

      setPins([...leadPins, ...customerPins]);
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
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
        setRecenterSignal((n) => n + 1);
      },
      (err) => {
        console.error(err);
        setError(
          err.code === 1
            ? "Location permission was denied. Enable it in your browser settings."
            : "Couldn't get your location."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // Live tracking — watch position as the user moves.
  useEffect(() => {
    if (!tracking) return;
    if (!navigator.geolocation) {
      setError("Location isn't available on this device/browser.");
      setTracking(false);
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
      },
      (err) => {
        console.error(err);
        setError(
          err.code === 1
            ? "Location permission was denied. Enable it in your browser settings."
            : "Lost your location signal."
        );
        setTracking(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [tracking]);

  function toggleTracking() {
    setTracking((t) => {
      const next = !t;
      if (next) setRecenterSignal((n) => n + 1); // center when turning on
      return next;
    });
  }

  function goToRecord(pin) {
    navigate(pin.kind === "lead" ? `/leads/${pin.id}` : `/customers/${pin.id}`);
  }

  function handleCreated() {
    setNewLeadLocation(null);
    load(); // refresh pins to show the new lead
  }

  if (loading) return <div className="mapview__state">Loading map…</div>;

  return (
    <div className="mapview">
      {error && <p className="mapview__error">{error}</p>}

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
          mapId="skyblue_crm_map"
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={13}
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          {pins.map((pin) => {
            const color = STATUS_COLORS[pin.status] || STATUS_COLORS.none;
            return (
              <Circle
                key={pin.key}
                center={pin.position}
                radius={7}
                strokeColor={color}
                strokeOpacity={0.9}
                strokeWeight={2}
                fillColor={color}
                fillOpacity={0.55}
                clickable={!addMode}
                onClick={() => !addMode && setSelected(pin)}
              />
            );
          })}

          <ClickToAdd active={addMode} onPicked={handlePicked} />

          {userPos && <UserLocation position={userPos} accuracy={accuracy} />}
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
    </div>
  );
}