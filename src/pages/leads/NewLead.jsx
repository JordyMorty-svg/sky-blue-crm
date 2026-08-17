import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  createLead,
  MANUAL_ADD_STAGES,
  TEMPERATURES,
} from "../../services/leadService";
import { useAuth } from "../../context/useAuth";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO } from "../../components/appointmentUtils";
import AddressPicker from "../../components/AddressPicker";
import PlanPicker from "../../components/PlanPicker";
import "./NewLead.css";

const STAGE_LABELS = {
  contacted: "Contacted",
  quoted: "Quoted",
  booked: "Booked",
};

// What each stage is for, so the page explains itself rather than just
// showing a different set of fields with no reason given.
const STAGE_BLURBS = {
  contacted: "Knocked and spoke to someone. No price yet.",
  quoted: "Gave them a price. Not booked in yet.",
  booked: "They said yes — capture the plan and the appointment.",
};

export default function NewLead() {
  const { stage } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState(null);
  const [longitude, setLongitude] = useState(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [estimate, setEstimate] = useState("");
  const [stories, setStories] = useState("one");
  const [windows, setWindows] = useState(1);
  const [interior, setInterior] = useState(false);
  const [appointmentDate, setAppointmentDate] = useState(null);
  const [appointmentTime, setAppointmentTime] = useState("");
  const [temperature, setTemperature] = useState("");
  const [propertyType, setPropertyType] = useState("residential");
  const [servicePlan, setServicePlan] = useState("one_time");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // An unknown stage in the URL would otherwise create a lead in a status
  // the board can't show.
  if (!MANUAL_ADD_STAGES.includes(stage)) {
    return (
      <div className="newlead__state">
        <p>That isn't a stage you can add a lead to.</p>
        <button className="newlead__back" onClick={() => navigate("/leads")}>
          ← Back to pipeline
        </button>
      </div>
    );
  }

  const needsPrice = stage === "quoted" || stage === "booked";
  const needsAppointment = stage === "booked";

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

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
      await createLead(
        {
          status: stage,
          name: name.trim(),
          address: address.trim(),
          latitude,
          longitude,
          phone: phone.trim(),
          email: email.trim() || null,
          stories,
          windows: Number(windows) || 1,
          interior,
          estimate: estimate ? Number(estimate) : 0,
          appointment_at: combineToISO(appointmentDate, appointmentTime),
          temperature: temperature || null,
          property_type: propertyType,
          service_plan: servicePlan,
          notes: notes.trim() || null,
        },
        user?.id ?? null
      );
      navigate("/leads");
    } catch (err) {
      console.error(err);
      setError("Couldn't save the lead. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="newlead">
      <button className="newlead__back" onClick={() => navigate("/leads")}>
        ← Back to pipeline
      </button>

      <header className="newlead__head">
        <h1 className="newlead__title">
          New lead <span className="newlead__stage">{STAGE_LABELS[stage]}</span>
        </h1>
        <p className="newlead__blurb">{STAGE_BLURBS[stage]}</p>
      </header>

      {error && <p className="newlead__error">{error}</p>}

      <form className="newlead__form" onSubmit={handleSubmit}>
        <section className="newlead__section">
          <h2 className="newlead__sectiontitle">Contact</h2>
          <div className="newlead__grid">
            <Field label="Name" full>
              <input
                className="newlead__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                autoFocus
              />
            </Field>

            <Field label="Address" full>
              <AddressPicker
                value={address}
                onChange={({ address, latitude, longitude }) => {
                  setAddress(address);
                  setLatitude(latitude);
                  setLongitude(longitude);
                }}
                onTextChange={(text) => {
                  setAddress(text);
                  // Typed freely rather than selected — drop stale coordinates.
                  setLatitude(null);
                  setLongitude(null);
                }}
                placeholder="123 Main St, Corvallis"
              />
            </Field>

            <Field label="Phone">
              <input
                className="newlead__input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(541) 555-0123"
              />
            </Field>

            <Field
              label="Email"
              hint={needsAppointment ? "for receipts and invoices" : "optional"}
            >
              <input
                className="newlead__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@email.com"
              />
            </Field>
          </div>
        </section>

        <section className="newlead__section">
          <h2 className="newlead__sectiontitle">The job</h2>
          <div className="newlead__grid">
            <Field label="Stories">
              <select
                className="newlead__input"
                value={stories}
                onChange={(e) => setStories(e.target.value)}
              >
                <option value="one">One story</option>
                <option value="two">Two story</option>
              </select>
            </Field>

            <Field label="Windows">
              <input
                className="newlead__input"
                type="number"
                min="1"
                value={windows}
                onChange={(e) => setWindows(e.target.value)}
              />
            </Field>

            {needsPrice && (
              <Field label="Quoted price ($)">
                <input
                  className="newlead__input"
                  type="number"
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                  placeholder="300"
                  min="0"
                />
              </Field>
            )}

            {stage !== "booked" && (
              <Field label="Temperature" hint="how keen they seemed">
                <select
                  className="newlead__input"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                >
                  <option value="">— not set —</option>
                  {TEMPERATURES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Interior cleaning">
              <label className="newlead__check">
                <input
                  type="checkbox"
                  checked={interior}
                  onChange={(e) => setInterior(e.target.checked)}
                />
                <span>Included</span>
              </label>
            </Field>
          </div>
        </section>

        {needsAppointment && (
          <>
            <section className="newlead__section">
              <h2 className="newlead__sectiontitle">Service plan</h2>
              <PlanPicker
                propertyType={propertyType}
                plan={servicePlan}
                onPropertyTypeChange={setPropertyType}
                onPlanChange={setServicePlan}
                basePrice={estimate}
              />
            </section>

            <section className="newlead__section">
              <h2 className="newlead__sectiontitle">First appointment</h2>
              <AppointmentPicker
                date={appointmentDate}
                time={appointmentTime}
                onDateChange={setAppointmentDate}
                onTimeChange={setAppointmentTime}
              />
            </section>
          </>
        )}

        <section className="newlead__section">
          <h2 className="newlead__sectiontitle">Notes</h2>
          <textarea
            className="newlead__input newlead__textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Interested, wants a callback next week…"
            rows="3"
          />
        </section>

        <div className="newlead__actions">
          <button
            type="submit"
            className="newlead__submit"
            disabled={busy}
          >
            {busy ? "Saving…" : `Add to ${STAGE_LABELS[stage]}`}
          </button>
          <button
            type="button"
            className="newlead__cancel"
            onClick={() => navigate("/leads")}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children, full }) {
  return (
    <div className={`newlead__field ${full ? "newlead__field--full" : ""}`}>
      <label className="newlead__label">
        {label}
        {hint && <span className="newlead__hint"> ({hint})</span>}
      </label>
      {children}
    </div>
  );
}
