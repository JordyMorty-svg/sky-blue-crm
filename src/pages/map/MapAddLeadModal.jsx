import { useState } from "react";
import { createLead, TEMPERATURES } from "../../services/leadService";
import { useAuth } from "../../context/AuthContext";
import AppointmentPicker, { combineToISO } from "../../components/AppointmentPicker";
import "../../components/AddLeadModal.css";

// Create a lead from a location clicked on the map. Address + coordinates
// come pre-filled from the reverse-geocoded click; the rep fills the rest.
export default function MapAddLeadModal({ location, onClose, onCreated }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [address, setAddress] = useState(location.address || "");
  const [phone, setPhone] = useState("");
  const [estimate, setEstimate] = useState("");
  const [temperature, setTemperature] = useState("");
  const [notes, setNotes] = useState("");
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [stage, setStage] = useState("contacted");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (stage === "booked" && (!apptDate || !apptTime)) {
      setError("A booked lead needs a date and time.");
      return;
    }
    if ((stage === "quoted" || stage === "booked") && !estimate) {
      setError("A price is required for quoted or booked.");
      return;
    }

    setBusy(true);
    try {
      const newLead = await createLead(
        {
          status: stage,
          name: name.trim(),
          address: address.trim(),
          phone: phone.trim(),
          latitude: location.lat,
          longitude: location.lng,
          stories: "one",
          windows: 1,
          interior: false,
          estimate: estimate ? Number(estimate) : 0,
          appointment_at: combineToISO(apptDate, apptTime),
          temperature: temperature || null,
          notes: notes.trim() || null,
        },
        user?.id ?? null
      );
      onCreated(newLead);
    } catch (err) {
      console.error(err);
      setError("Couldn't create the lead. Try again.");
      setBusy(false);
    }
  }

  return (
    <div
      className="modal"
      onMouseDown={(e) => {
        // Only close if the press STARTED on the overlay itself — not a
        // text-selection/drag that ends here.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal__card">
        <div className="modal__head">
          <h2 className="modal__title">New lead at this location</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="modal__form" onSubmit={handleSubmit}>
          <label className="modal__label">Stage</label>
          <select
            className="modal__input"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="contacted">Contacted</option>
            <option value="quoted">Quoted</option>
            <option value="booked">Booked</option>
          </select>

          <label className="modal__label">Name</label>
          <input
            className="modal__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
          />

          <label className="modal__label">Address</label>
          <input
            className="modal__input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Address"
          />

          <label className="modal__label">Phone</label>
          <input
            className="modal__input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(541) 555-0123"
          />

          {(stage === "quoted" || stage === "booked") && (
            <>
              <label className="modal__label">Price estimate ($)</label>
              <input
                className="modal__input"
                type="number"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
              />
            </>
          )}

          {stage === "booked" && (
            <AppointmentPicker
              date={apptDate}
              time={apptTime}
              onDateChange={setApptDate}
              onTimeChange={setApptTime}
            />
          )}

          {stage !== "booked" && (
            <>
              <label className="modal__label">Temperature</label>
              <select
                className="modal__input"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              >
                <option value="">— not set —</option>
                {TEMPERATURES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </>
          )}

          <label className="modal__label">Notes</label>
          <textarea
            className="modal__input"
            rows="3"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Interested, wants a callback next week…"
          />

          {error && <p className="modal__error">{error}</p>}

          <div className="modal__actions">
            <button type="button" className="modal__btn modal__btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal__btn modal__btn--primary" disabled={busy}>
              {busy ? "Creating…" : "Add lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}