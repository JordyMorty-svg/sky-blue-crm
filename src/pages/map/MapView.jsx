import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Map, InfoWindow } from "@vis.gl/react-google-maps";
import { Circle } from "./Circle.jsx";
import { fetchMapLeads, fetchMapCustomers } from "../../services/mapService";
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

// Scheduled wins over completed (upcoming work is the active state).
function customerStatus(customer) {
  const jobs = customer.jobs || [];
  if (jobs.some((j) => j.status === "scheduled")) return "scheduled";
  if (jobs.some((j) => j.status === "completed")) return "completed";
  return "none";
}

export default function MapView() {
  const navigate = useNavigate();
  const [pins, setPins] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  // Route based on kind/status when a circle is clicked's "view" button.
  function goToRecord(pin) {
    if (pin.kind === "lead") {
      navigate(`/leads/${pin.id}`);
    } else {
      // customer (completed or scheduled) -> customer profile
      navigate(`/customers/${pin.id}`);
    }
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

      <div className="mapview__map">
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
                radius={12}
                strokeColor={color}
                strokeOpacity={0.9}
                strokeWeight={2}
                fillColor={color}
                fillOpacity={0.55}
                clickable={true}
                onClick={() => setSelected(pin)}
              />
            );
          })}

          {selected && (
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
    </div>
  );
}