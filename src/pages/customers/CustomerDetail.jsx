import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchCustomer, updateCustomer } from "../../services/customerService";
import { fetchNextVisit, RECURRING_LEAD_TIME_DAYS } from "../../services/jobService";
import {
  PROPERTY_TYPES,
  SERVICE_PLANS,
  planFor,
} from "../../services/leadService";
import AddressPicker from "../../components/AddressPicker";
import "./Customers.css";

function formatWhen(iso) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

const STATUS_LABELS = {
  scheduled: "Scheduled",
  upcoming: "Due",
  completed: "Completed",
  cancelled: "Cancelled",
};

function formatDue(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [leadNotes, setLeadNotes] = useState([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [nextVisit, setNextVisit] = useState(null);

  async function load() {
    try {
      const { customer, jobs, leadNotes } = await fetchCustomer(id);
      setCustomer(customer);
      setForm(customer);
      setJobs(jobs);
      setLeadNotes(leadNotes);
      setNextVisit(await fetchNextVisit(id));
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
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
    setForm((cur) => ({ ...cur, [field]: value }));
  }

  async function handleSave() {
    setError("");
    if (!form.name?.trim()) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    try {
      await updateCustomer(id, {
        name: form.name.trim(),
        phone: form.phone?.trim() || null,
        email: form.email?.trim() || null,
        address: form.address?.trim() || null,
        latitude: form.latitude ?? null,
        longitude: form.longitude ?? null,
        notes: form.notes?.trim() || null,
        property_type: form.property_type || "residential",
        service_plan: form.service_plan || "one_time",
      });
      setCustomer(form);
      setEditing(false);
    } catch (e) {
      console.error(e);
      setError("Couldn't save changes. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setForm(customer);
    setEditing(false);
    setError("");
  }

  if (loading) return <div className="customers__state">Loading…</div>;
  if (!customer) return <div className="customers__state">{error || "Not found."}</div>;

  const plan = planFor(customer.service_plan);
  const isRecurring = (customer.service_plan || "one_time") !== "one_time";
  const propertyType = customer.property_type || "residential";

  const totalPaid = jobs
    .filter((j) => j.status === "completed")
    .reduce((sum, j) => sum + Number(j.final_price ?? j.price ?? 0), 0);

  return (
    <div className="custdetail">
      <button className="custdetail__back" onClick={() => navigate("/customers")}>
        ← Back to customers
      </button>

      {error && <p className="customers__error">{error}</p>}

      {editing ? (
        <div className="custedit">
          <label className="custedit__label">Name</label>
          <input
            className="custedit__input"
            value={form.name || ""}
            onChange={(e) => set("name", e.target.value)}
          />
          <label className="custedit__label">Phone</label>
          <input
            className="custedit__input"
            value={form.phone || ""}
            onChange={(e) => set("phone", e.target.value)}
          />
          <label className="custedit__label">Email</label>
          <input
            className="custedit__input"
            type="email"
            value={form.email || ""}
            onChange={(e) => set("email", e.target.value)}
          />
          <label className="custedit__label">Address</label>
          <AddressPicker
            value={form.address || ""}
            onChange={({ address, latitude, longitude }) => {
              setForm((cur) => ({ ...cur, address, latitude, longitude }));
            }}
            onTextChange={(text) => {
              setForm((cur) => ({
                ...cur,
                address: text,
                latitude: null,
                longitude: null,
              }));
            }}
            placeholder="123 Main St, Corvallis"
          />
          <label className="custedit__label">Property type</label>
          <select
            className="custedit__input"
            value={form.property_type || "residential"}
            onChange={(e) => set("property_type", e.target.value)}
          >
            {PROPERTY_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>

          <label className="custedit__label">Service plan</label>
          <select
            className="custedit__input"
            value={form.service_plan || "one_time"}
            onChange={(e) => set("service_plan", e.target.value)}
          >
            {SERVICE_PLANS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          <label className="custedit__label">Notes</label>
          <textarea
            className="custedit__input custedit__textarea"
            rows="4"
            placeholder="Prefers morning appointments, gate code, has a dog…"
            value={form.notes || ""}
            onChange={(e) => set("notes", e.target.value)}
          />
          <div className="custedit__actions">
            <button className="custedit__save" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="custedit__cancel" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="custdetail__namerow">
            <h1 className="custdetail__name">{customer.name}</h1>
            <button
              className="custdetail__schedule"
              onClick={() => navigate(`/customers/${id}/schedule`)}
            >
              + Schedule a job
            </button>
            <button className="custdetail__edit" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>

          <div className="custdetail__badges">
            {isRecurring && (
              <span className="custbadge custbadge--recurring">
                Recurring client · {plan.label}
              </span>
            )}
            <span className={`custbadge custbadge--${propertyType}`}>
              {propertyType === "commercial" ? "Commercial" : "Residential"}
            </span>
          </div>

          <div className="custdetail__info">
            {customer.phone && <span>{customer.phone}</span>}
            {customer.email && <span>{customer.email}</span>}
            {customer.address && <span>{customer.address}</span>}
          </div>

          {customer.notes && (
            <div className="custdetail__notes">
              <span className="custdetail__notes-label">Notes</span>
              <p className="custdetail__notes-text">{customer.notes}</p>
            </div>
          )}
        </>
      )}

      {leadNotes.length > 0 && (
        <div className="custdetail__leadnotes">
          <span className="custdetail__notes-label">From the original lead</span>
          {leadNotes.map((ln) => (
            <p key={ln.id} className="custdetail__notes-text">{ln.notes}</p>
          ))}
        </div>
      )}

      <div className="custdetail__stats">
        <div className="custdetail__stat">
          <span className="custdetail__stat-num">{jobs.length}</span>
          <span className="custdetail__stat-label">Total jobs</span>
        </div>
        <div className="custdetail__stat">
          <span className="custdetail__stat-num">${totalPaid.toLocaleString()}</span>
          <span className="custdetail__stat-label">Lifetime value</span>
        </div>
      </div>

      {nextVisit && (
        <div className="custdetail__nextvisit">
          <span className="custdetail__nextvisit-label">Next visit due</span>
          <strong className="custdetail__nextvisit-date">
            {formatDue(nextVisit.starts_at)}
          </strong>
          <span className="custdetail__nextvisit-note">
            ${nextVisit.price} · not scheduled yet — it moves onto the Jobs
            board {RECURRING_LEAD_TIME_DAYS} days beforehand so a crew can be
            assigned.
          </span>
        </div>
      )}

      <h2 className="custdetail__subhead">Job history</h2>
      {jobs.length === 0 ? (
        <p className="customers__empty">No jobs yet.</p>
      ) : (
        <>
          {jobs.some((j) => j.status === "scheduled") && (
            <div className="custdetail__scheduled">
              <span className="custdetail__scheduled-label">Upcoming — scheduled, not yet complete</span>
              {jobs
                .filter((j) => j.status === "scheduled")
                .map((job) => (
                  <div
                    className="custjob custjob--upcoming custjob--clickable"
                    key={job.id}
                    onClick={() => navigate(`/jobs/${job.id}`)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="custjob__main">
                      <span className="custjob__when">{formatWhen(job.starts_at)}</span>
                      <span className="custjob__meta">
                        {job.services} · {job.duration_hours}h
                      </span>
                      <span className="custjob__crew">
                        {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                      </span>
                    </div>
                    <div className="custjob__right">
                      <span className="custjob__price">
                        ${(job.final_price ?? job.price ?? 0).toLocaleString()}
                      </span>
                      <span className="custjob__status custjob__status--scheduled">
                        Scheduled
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="customers__list">
            {jobs
              .filter((j) => j.status !== "scheduled" && j.status !== "upcoming")
              .map((job) => (
                <div className="custjob" key={job.id}>
                  <div className="custjob__main">
                    <span className="custjob__when">{formatWhen(job.starts_at)}</span>
                    <span className="custjob__meta">
                      {job.services} · {job.duration_hours}h
                    </span>
                    <span className="custjob__crew">
                      {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                    </span>
                  </div>
                  <div className="custjob__right">
                    <span className="custjob__price">
                      ${(job.final_price ?? job.price ?? 0).toLocaleString()}
                    </span>
                    <span className={`custjob__status custjob__status--${job.status}`}>
                      {STATUS_LABELS[job.status] || job.status}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}