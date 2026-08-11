import { useEffect, useState } from "react";
import { fetchCompletedJobs } from "../../services/customerService";
import "./Income.css";

// Group key for a date at day / week / month granularity.
function groupKey(date, grouping) {
  const d = new Date(date);
  if (grouping === "day") {
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  if (grouping === "week") {
    // Start of that week (Sunday).
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    return `Week of ${start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  // month
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function Income() {
  const [jobs, setJobs] = useState([]);
  const [grouping, setGrouping] = useState("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchCompletedJobs();
      setJobs(data);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load income data.");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="income__state">Loading…</div>;

  // Only completed jobs with a date and an amount.
  const paidJobs = jobs.filter((j) => j.starts_at && (j.final_price ?? j.price));

  const total = paidJobs.reduce((sum, j) => sum + Number(j.final_price ?? j.price ?? 0), 0);

  // Group into buckets.
  const buckets = {};
  for (const job of paidJobs) {
    const key = groupKey(job.starts_at, grouping);
    if (!buckets[key]) buckets[key] = { total: 0, count: 0 };
    buckets[key].total += Number(job.final_price ?? job.price ?? 0);
    buckets[key].count += 1;
  }
  // Preserve order: paidJobs is already newest-first, so keys appear newest-first.
  const orderedKeys = [];
  for (const job of paidJobs) {
    const key = groupKey(job.starts_at, grouping);
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
  }

  return (
    <div className="income">
      <div className="income__head">
        <h1 className="income__title">Income</h1>
        <div className="income__groups">
          {["day", "week", "month"].map((g) => (
            <button
              key={g}
              className={`income__group ${grouping === g ? "income__group--active" : ""}`}
              onClick={() => setGrouping(g)}
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="income__error">{error}</p>}

      <div className="income__total">
        <span className="income__total-label">Total collected</span>
        <span className="income__total-amount">${total.toLocaleString()}</span>
        <span className="income__total-count">{paidJobs.length} completed jobs</span>
      </div>

      {orderedKeys.length === 0 ? (
        <p className="income__empty">No completed jobs yet.</p>
      ) : (
        <div className="income__list">
          {orderedKeys.map((key) => (
            <div className="income__row" key={key}>
              <div className="income__row-label">
                <span className="income__period">{key}</span>
                <span className="income__jobs">{buckets[key].count} jobs</span>
              </div>
              <span className="income__amount">${buckets[key].total.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}