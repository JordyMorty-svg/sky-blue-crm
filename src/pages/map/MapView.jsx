import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Map, InfoWindow, useMap, useMapsLibrary, MapControl, ControlPosition } from "@vis.gl/react-google-maps";
import { Circle } from "./Circle.jsx";
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