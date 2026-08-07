import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchLead,
  updateLead,
  deleteLead,
  LEADS_SETTABLE_STATUSES,
  TEMPERATURES,
} from "../../services/leadService";
import "./LeadDetail.css";

// Convert a DB timestamp to the value a datetime-local input expects.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    try {
      setLoading(true);
      const lead = await fetchLead(id);
      setForm({
        ...lead,
        appointment_at: toLocalInput(lead.appointment_at),
      });
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this lead.");
    } finally {
      setLoading(false);
    }
  }

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
        appointment_at: form.appointment_at
          ? new Date(form.appointment_at).toISOString()
          : null,
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

        <Field label="Appointment">
          <input className="detail__input" type="datetime-local"
            value={form.appointment_at || ""}
            onChange={(e) => set("appointment_at", e.target.value)} />
        </Field>

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

function Field({ label, children, full }) {
  return (
    <div className={`detail__field ${full ? "detail__field--full" : ""}`}>
      <label className="detail__label">{label}</label>
      {children}
    </div>
  );
}