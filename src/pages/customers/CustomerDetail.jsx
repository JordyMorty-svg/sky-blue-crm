import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchCustomer } from "../../services/customerService";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    try {
      setLoading(true);
      const { customer, jobs } = await fetchCustomer(id);
      setCustomer(customer);
      setJobs(jobs);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
    } finally {
      setLoading(false);
    }
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

      <h1 className="custdetail__name">{customer.name}</h1>

      <div className="custdetail__info">
        {customer.phone && <span>{customer.phone}</span>}
        {customer.email && <span>{customer.email}</span>}
        {customer.address && <span>{customer.address}</span>}
      </div>

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