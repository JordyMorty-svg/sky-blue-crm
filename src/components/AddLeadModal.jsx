import { useState } from "react";
import { createLead, TEMPERATURES } from "../services/leadService";
import { useAuth } from "../context/useAuth";
import AppointmentPicker from "./AppointmentPicker";
import { combineToISO } from "./appointmentUtils";
import AddressPicker from "./AddressPicker";
import "./AddLeadModal.css";

// What each stage requires. Every stage collects name/address/phone/notes;
// quoted adds price; booked adds price + appointment time.
const STAGE_LABELS = {
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
};

export default function AddLeadModal({ stage, onClose, onCreated }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState(null);
  const [longitude, setLongitude] = useState(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [estimate, setEstimate] = useState("");
  const [appointmentDate, setAppointmentDate] = useState(null);
  const [appointmentTime, setAppointmentTime] = useState("");
  const [temperature, setTemperature] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const needsPrice = stage === "quoted" || stage === "booked";
  const needsAppointment = stage === "booked";

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    // Validation scaled to the stage.
    if (!name.trim() || !address.trim() || !phone.trim()) {
      setError("Name, address, and phone are required.");
      return;
    }
    if (needsPrice && !estimate) {
      setError("A quoted lead needs a price.");
      return;
    }
    if (needsAppointment && (!appointmentDate || !appointmentTime)) {
      setError("A booked lead needs both a date and a time.");
      return;
    }

    setBusy(true);
    try {
      const newLead = await createLead(
        {
          status: stage,
          name: name.trim(),
          address: address.trim(),
          latitude,
          longitude,
          phone: phone.trim(),
          email: email.trim() || null,
          // These columns are NOT NULL on the table, so give safe defaults.
          stories: "one",
          windows: 1,
          interior: false,
          estimate: estimate ? Number(estimate) : 0,
          appointment_at: combineToISO(appointmentDate, appointmentTime),
          temperature: temperature || null,
          notes: notes.trim() || null,
        },
        user?.id ?? null
      );
      onCreated(newLead);
    } catch (err) {
      console.error(err);
      setError("Couldn't save the lead. Try again.");
      setBusy(false);
    }
  }

  return (
    <div
      className="modal"
      onMouseDown={(e) => {
        // Only close if the press STARTED on the overlay itself — not a
        // text selection/delete drag that happens to end here.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal__card">
        <div className="modal__head">
          <h2 className="modal__title">
            Add to <span className="modal__stage">{STAGE_LABELS[stage]}</span>
          </h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="modal__form" onSubmit={handleSubmit}>
          <label className="modal__label">Name</label>
          <input
            className="modal__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            autoFocus
          />

          <label className="modal__label">Address</label>
          <AddressPicker
            value={address}
            onChange={({ address, latitude, longitude }) => {
              setAddress(address);
              setLatitude(latitude);
              setLongitude(longitude);
            }}
            onTextChange={(text) => {
              setAddress(text);
              // Typed freely (not selected) — clear stale coordinates.
              setLatitude(null);
              setLongitude(null);
            }}
            placeholder="123 Main St, Corvallis"
          />

          <label className="modal__label">Phone</label>
          <input
            className="modal__input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(541) 555-0123"
          />

          {stage === "booked" && (
            <>
              <label className="modal__label">
                Email <span className="modal__optional">(optional)</span>
              </label>
              <input
                className="modal__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@email.com"
              />
            </>
          )}

          {needsPrice && (
            <>
              <label className="modal__label">Quoted price ($)</label>
              <input
                className="modal__input"
                type="number"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                placeholder="300"
                min="0"
              />
            </>
          )}

          {needsAppointment && (
            <AppointmentPicker
              date={appointmentDate}
              time={appointmentTime}
              onDateChange={setAppointmentDate}
              onTimeChange={setAppointmentTime}
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
            className="modal__input modal__textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Interested, wants a callback next week…"
            rows="3"
          />

          {error && <p className="modal__error">{error}</p>}

          <div className="modal__actions">
            <button
              type="button"
              className="modal__btn modal__btn--ghost"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal__btn modal__btn--primary"
              disabled={busy}
            >
              {busy ? "Saving…" : "Add lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}