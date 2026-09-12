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
  LEAD_SOURCES,
  sourceFor,
  SERVICE_TYPES,
  serviceFor,
  telHref,
  recordLeadContact,
} from "../../services/leadService";
import { useAuth } from "../../context/useAuth";
import { can } from "../../components/capabilities";
import PlanPicker from "../../components/PlanPicker";
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
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { role } = useAuth();
  const canDelete = can(role, "delete_leads");
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
        // The save payload is an explicit column list, not a spread of
        // `form` — so a new editable field is invisible until it's named
        // here. The picker would have looked like it worked and quietly
        // reverted on reload.
        source: form.source || "door",
        // No `|| DEFAULT_SERVICE` here on purpose — see the picker below.
        // Null means nobody recorded it, which is a fact worth keeping.
        service: form.service || null,
        property_type: form.property_type || "residential",
        service_plan: form.service_plan || "one_time",
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

  // Dials, and records the attempt as it goes. The status rule lives in the
  // database (record_lead_contact) so it can't drift between this page and
  // the board: a lead still on 'new' advances to 'contacted', anything
  // further down the funnel keeps its place.
  async function handleCall() {
    setCalling(true);
    try {
      const updated = await recordLeadContact(id);
      if (updated) setForm((f) => ({ ...f, ...updated }));
    } catch (e) {
      console.error(e);
      setError("Couldn't record that call. The number still dialled.");
    } finally {
      setCalling(false);
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
          {sourceFor(form.source).label}
          {form.creator?.full_name ? ` · ${form.creator.full_name}` : ""}
        </span>
      </div>

      <h1 className="detail__title">{form.name || "Lead"}</h1>

      {/* What they want, under the name rather than buried in the form —
          it's the first thing you need before ringing them back, and on a
          gutter lead it's the only thing distinguishing this from every
          other lead on the board. */}
      <div className="detail__tags">
        {form.service && (
          <span className="detail__service">{serviceFor(form.service).label}</span>
        )}
        <span
          className={`detail__property detail__property--${
            form.property_type || "residential"
          }`}
        >
          {(form.property_type || "residential") === "commercial"
            ? "Commercial"
            : "Residential"}
        </span>
      </div>

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
          <div className="detail__phonerow">
            <input className="detail__input" type="tel" value={form.phone || ""}
              onChange={(e) => set("phone", e.target.value)} />
            {telHref(form.phone) && (
              <a
                className="detail__call"
                href={telHref(form.phone)}
                onClick={handleCall}
                aria-disabled={calling}
              >
                Call
              </a>
            )}
          </div>
          <p className="detail__lastcall">
            {form.last_contacted_at ? (
              <>
                Last reached out {formatContacted(form.last_contacted_at)}
                {form.contact_attempts > 1
                  ? ` · ${form.contact_attempts} attempts`
                  : ""}
                {" · "}
              </>
            ) : null}
            {/* The calls themselves live on the history page, which outlives
                this lead — once they book, the same timeline is reachable
                from their customer profile. */}
            <button
              type="button"
              className="detail__historylink"
              onClick={() =>
                navigate(`/history/lead/${id}`, {
                  state: {
                    from: `/leads/${id}`,
                    person: { name: form.name, phone: form.phone },
                  },
                })
              }
            >
              See full history
            </button>
          </p>
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

        <Field label="Where they came from">
          <select className="detail__input" value={form.source || "door"}
            onChange={(e) => set("source", e.target.value)}>
            {/* Keep an unrecognised value selectable rather than silently
                switching the lead to Door knock the next time anyone opens
                it. Same guard the status select uses. */}
            {!LEAD_SOURCES.some((s) => s.key === (form.source || "door")) && (
              <option value={form.source}>{form.source}</option>
            )}
            {LEAD_SOURCES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Service they asked about">
          {/* No default applied here, unlike source. A website lead carries
              the service the customer picked; a lead with nothing recorded
              predates the service column, and quietly relabelling it as
              window washing would invent an answer it never had. */}
          <select className="detail__input" value={form.service || ""}
            onChange={(e) => set("service", e.target.value || null)}>
            <option value="">— not recorded —</option>
            {form.service && !SERVICE_TYPES.some((s) => s.key === form.service) && (
              <option value={form.service}>{serviceFor(form.service).label}</option>
            )}
            {SERVICE_TYPES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
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
          <PlanPicker
            propertyType={form.property_type || "residential"}
            plan={form.service_plan || "one_time"}
            onPropertyTypeChange={(v) => set("property_type", v)}
            onPlanChange={(v) => set("service_plan", v)}
            basePrice={form.estimate}
          />
        </div>

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
            {events
              .filter((ev) => (ev.kind || "status") !== "call")
              .map((ev) => (
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

        {/* Owners only. A deleted lead is a row gone from the database
            along with its event history, and there is no undo anywhere in
            the CRM — so the button isn't dimmed for a tech, it's absent.
            A disabled control invites a support conversation; a missing one
            doesn't raise the question. */}
        {canDelete && (
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
        )}
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

// "today", "yesterday", or a date. Relative wording for the recent past is
// what people actually want here — "did we ring them today or last week" is
// the question, and a bare date makes you do the arithmetic.
function formatContacted(iso) {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) {
    return `today at ${then.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${formatEventDate(iso)}`;
}

function Field({ label, children, full }) {
  return (
    <div className={`detail__field ${full ? "detail__field--full" : ""}`}>
      <label className="detail__label">{label}</label>
      {children}
    </div>
  );
}