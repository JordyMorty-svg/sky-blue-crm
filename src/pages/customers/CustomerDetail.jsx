import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchCustomer, updateCustomer } from "../../services/customerService";
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
  completed: "Completed",
  cancelled: "Cancelled",
};

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    try {
      setLoading(true);
      const { customer, jobs, leadNotes } = await fetchCustomer(id);
      setCustomer(customer);
      setForm(customer);
      setJobs(jobs);
      setLeadNotes(leadNotes);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
    } finally {
      setLoading(false);
    }
  }

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
        notes: form.notes?.trim() || null,
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
          <input
            className="custedit__input"
            value={form.address || ""}
            onChange={(e) => set("address", e.target.value)}
          />
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
            <button className="custdetail__edit" onClick={() => setEditing(true)}>
              Edit
            </button>
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

      <h2 className="custdetail__subhead">Job history</h2>
      {jobs.length === 0 ? (
        <p className="customers__empty">No jobs yet.</p>
      ) : (
        <div className="customers__list">
          {jobs.map((job) => (
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
      )}
    </div>
  );
}