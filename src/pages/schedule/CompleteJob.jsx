import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchJob, completeJob } from "../../services/jobService";
import "./CompleteJob.css";

const PAYMENT_METHODS = [
  { key: "cash", label: "Cash" },
  { key: "check", label: "Check" },
  { key: "card", label: "Card" },
  { key: "square", label: "Square" },
];

export default function CompleteJob() {
  const { jobId } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [finalPrice, setFinalPrice] = useState("");
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchJob(jobId);
      setJob(data);
      // Default the amount to the quoted price — editable for upsells.
      setFinalPrice(data.price ?? "");
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this job.");
    } finally {
      setLoading(false);
    }
  }

  async function handleComplete() {
    setError("");
    if (!finalPrice || Number(finalPrice) < 0) {
      setError("Enter the amount received.");
      return;
    }
    if (!method) {
      setError("Select a payment method.");
      return;
    }

    setSaving(true);
    try {
      await completeJob(job, {
        finalPrice: Number(finalPrice),
        paymentMethod: method,
        paymentNotes: notes.trim() || null,
      });
      navigate("/schedule");
    } catch (e) {
      console.error(e);
      setError("Couldn't complete the job. Try again.");
      setSaving(false);
    }
  }

  if (loading) return <div className="complete__state">Loading…</div>;
  if (!job) return <div className="complete__state">{error || "Not found."}</div>;

  const quoted = job.price ?? 0;
  const diff = finalPrice ? Number(finalPrice) - quoted : 0;

  return (
    <div className="complete">
      <button className="complete__back" onClick={() => navigate("/schedule")}>
        ← Back to schedule
      </button>

      <h1 className="complete__title">Complete job</h1>

      <div className="complete__job">
        <strong>{job.lead?.name || "Job"}</strong>
        <span>{job.lead?.address}</span>
        <span>Quoted: ${quoted}</span>
      </div>

      {error && <p className="complete__error">{error}</p>}

      <div className="complete__form">
        <label className="complete__label">Amount received ($)</label>
        <input
          className="complete__input"
          type="number"
          min="0"
          step="0.01"
          value={finalPrice}
          onChange={(e) => setFinalPrice(e.target.value)}
          autoFocus
        />
        {diff !== 0 && finalPrice !== "" && (
          <p className={`complete__diff ${diff > 0 ? "complete__diff--up" : "complete__diff--down"}`}>
            {diff > 0 ? `Upsell: +$${diff}` : `Under quote: -$${Math.abs(diff)}`}
          </p>
        )}

        <label className="complete__label">Payment method</label>
        <div className="complete__methods">
          {PAYMENT_METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`complete__method ${method === m.key ? "complete__method--active" : ""}`}
              onClick={() => setMethod(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="complete__label">Notes (optional)</label>
        <textarea
          className="complete__input complete__textarea"
          rows="2"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Upsold gutter cleaning, etc."
        />

        <div className="complete__actions">
          <button
            className="complete__submit"
            onClick={handleComplete}
            disabled={saving}
          >
            {saving ? "Completing…" : "Complete job"}
          </button>
          <button className="complete__cancel" onClick={() => navigate("/schedule")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}