import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchLead,
  fetchLeadEvents,
  updateLead,
  deleteLead,
  ALL_STATUSES,
  LEADS_SETTABLE_STATUSES,
  TEMPERATURES,
} from "../../services/leadService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import "./LeadDetail.css";

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState(null);
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [events, setEvents] = useState([]);

  async function load() {
    try {
      const lead = await fetchLead(id);
      setForm(lead);
      // History is nice-to-have — a failure here shouldn't stop the page
      // rendering the lead itself.
      try {
        setEvents(await fetchLeadEvents(id));
      } catch (histErr) {
        console.error("Couldn't load status history:", histErr);
        setEvents([]);
      }
      const { date, time } = splitFromISO(lead.appointment_at);
      setApptDate(date);
      setApptTime(time);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this lead.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Started inside the effect rather than called directly, so its
    // state updates land after the await instead of synchronously
    // during the effect (react-hooks/set-state-in-effect).
    void (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await updateLead(id, {
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        stories: form.stories,
        windows: Number(form.windows) || 1,
        interior: form.interior,
        estimate: Number(form.estimate) || 0,
        status: form.status,
        temperature: form.temperature || null,
        appointment_at: combineToISO(apptDate, apptTime),
        notes: form.notes || null,
        crm_notes: form.crm_notes || null,
      });
      navigate("/leads");
    } catch (e) {
      console.error(e);
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteLead(id);
      navigate("/leads");
    } catch (e) {
      console.error(e);
      setError("Couldn't delete. Try again.");
    }
  }

  if (loading) return <div className="detail__state">Loading…</div>;
  if (!form) return <div className="detail__state">{error || "Not found."}</div>;

  return (
    <div className="detail">
      <div className="detail__top">
        <button className="detail__back" onClick={() => navigate("/leads")}>
          ← Back to pipeline
        </button>
        <span className="detail__source">
          {form.source === "door" ? "Door knock" : "Website"}
          {form.creator?.full_name ? ` · ${form.creator.full_name}` : ""}
        </span>
      </div>

      <h1 className="detail__title">{form.name || "Lead"}</h1>

      {error && <p className="detail__error">{error}</p>}

      <div className="detail__grid">
        <Field label="Name">
          <input className="detail__input" value={form.name || ""}
            onChange={(e) => set("name", e.target.value)} />
        </Field>

        <Field label="Status">
          <select className="detail__input" value={form.status}
            onChange={(e) => set("status", e.target.value)}>
            {/* Always show the lead's current status, even if it isn't
                normally settable here (e.g. a scheduled lead viewed directly). */}
            {!LEADS_SETTABLE_STATUSES.some((s) => s.key === form.status) && (
              <option value={form.status}>{form.status}</option>
            )}
            {LEADS_SETTABLE_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Phone">
          <input className="detail__input" type="tel" value={form.phone || ""}
            onChange={(e) => set("phone", e.target.value)} />
        </Field>

        <Field label="Email">
          <input className="detail__input" type="email" value={form.email || ""}
            onChange={(e) => set("email", e.target.value)} />
        </Field>

        <Field label="Address" full>
          <input className="detail__input" value={form.address || ""}
            onChange={(e) => set("address", e.target.value)} />
        </Field>

        <Field label="Stories">
          <select className="detail__input" value={form.stories}
            onChange={(e) => set("stories", e.target.value)}>
            <option value="one">One story</option>
            <option value="two">Two story</option>
          </select>
        </Field>

        <Field label="Windows">
          <input className="detail__input" type="number" min="1" value={form.windows}
            onChange={(e) => set("windows", e.target.value)} />
        </Field>

        <Field label="Estimate ($)">
          <input className="detail__input" type="number" min="0" value={form.estimate}
            onChange={(e) => set("estimate", e.target.value)} />
        </Field>

        <Field label="Temperature">
          <select className="detail__input" value={form.temperature || ""}
            onChange={(e) => set("temperature", e.target.value)}>
            <option value="">— not set —</option>
            {TEMPERATURES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Interior cleaning">
          <label className="detail__check">
            <input type="checkbox" checked={form.interior}
              onChange={(e) => set("interior", e.target.checked)} />
            <span>Included</span>
          </label>
        </Field>

        <div className="detail__field detail__field--full">
          <AppointmentPicker
            date={apptDate}
            time={apptTime}
            onDateChange={setApptDate}
            onTimeChange={setApptTime}
          />
        </div>

        <Field label="Customer notes" full>
          <textarea className="detail__input detail__textarea" rows="2"
            value={form.notes || ""}
            onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <Field label="Internal notes (team only)" full>
          <textarea className="detail__input detail__textarea" rows="3"
            placeholder="Called 8/4, left voicemail…"
            value={form.crm_notes || ""}
            onChange={(e) => set("crm_notes", e.target.value)} />
        </Field>
      </div>

      {events.length > 0 && (
        <div className="detail__history">
          <h2 className="detail__historytitle">Status history</h2>
          <ol className="detail__timeline">
            {events.map((ev) => (
              <li key={ev.id} className="detail__event">
                <span className="detail__eventdot" />
                <span className="detail__eventtext">
                  {ev.from_status ? (
                    <>
                      {statusLabel(ev.from_status)} →{" "}
                      <strong>{statusLabel(ev.to_status)}</strong>
                    </>
                  ) : (
                    <>
                      Created as <strong>{statusLabel(ev.to_status)}</strong>
                    </>
                  )}
                </span>
                <span className="detail__eventdate">
                  {ev.actor?.full_name && (
                    <span className="detail__eventactor">
                      {ev.actor.full_name}
                    </span>
                  )}
                  {formatEventDate(ev.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="detail__actions">
        <button className="detail__save" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button className="detail__cancel" onClick={() => navigate("/leads")}>
          Cancel
        </button>

        <div className="detail__delete-wrap">
          {confirmDelete ? (
            <>
              <span className="detail__confirm-text">Delete permanently?</span>
              <button className="detail__delete-yes" onClick={handleDelete}>
                Yes, delete
              </button>
              <button className="detail__cancel" onClick={() => setConfirmDelete(false)}>
                No
              </button>
            </>
          ) : (
            <button className="detail__delete" onClick={() => setConfirmDelete(true)}>
              Delete lead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}

function formatEventDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Field({ label, children, full }) {
  return (
    <div className={`detail__field ${full ? "detail__field--full" : ""}`}>
      <label className="detail__label">{label}</label>
      {children}
    </div>
  );
}