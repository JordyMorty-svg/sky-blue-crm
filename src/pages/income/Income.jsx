import { useEffect, useState } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { fetchCompletedJobs } from "../../services/customerService";
import "./Income.css";

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "year", label: "This Year" },
  { key: "all", label: "All Time" },
  { key: "custom", label: "Custom" },
];

function startOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

// Returns [start, end) bounds for a period, or null for "all".
function periodBounds(period, customStart, customEnd) {
  const now = new Date();
  const sot = startOfToday();

  if (period === "today") {
    const end = new Date(sot);
    end.setDate(end.getDate() + 1);
    return [sot, end];
  }
  if (period === "week") {
    const start = new Date(sot);
    start.setDate(start.getDate() - start.getDay()); // Sunday
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return [start, end];
  }
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return [start, end];
  }
  if (period === "year") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear() + 1, 0, 1);
    return [start, end];
  }
  if (period === "custom") {
    if (!customStart) return null;
    const start = new Date(
      customStart.getFullYear(), customStart.getMonth(), customStart.getDate()
    );
    const endBase = customEnd || customStart;
    const end = new Date(
      endBase.getFullYear(), endBase.getMonth(), endBase.getDate() + 1
    );
    return [start, end];
  }
  return null; // all time
}

// How to bucket the breakdown list, based on the selected period.
function bucketGranularity(period) {
  if (period === "today" || period === "custom") return "day";
  if (period === "week") return "day";
  if (period === "month") return "day";
  if (period === "year") return "month";
  return "month"; // all time
}

function bucketKey(date, granularity) {
  const d = new Date(date);
  if (granularity === "day") {
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function Income() {
  const [jobs, setJobs] = useState([]);
  const [period, setPeriod] = useState("month");
  const [customStart, setCustomStart] = useState(null);
  const [customEnd, setCustomEnd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    try {
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

  useEffect(() => {
    // Started inside the effect rather than called directly, so its
    // state updates land after the await instead of synchronously
    // during the effect (react-hooks/set-state-in-effect).
    void (async () => {
      await load();
    })();
  }, []);

  if (loading) return <div className="income__state">Loading…</div>;

  const amountOf = (j) => Number(j.final_price ?? j.price ?? 0);
  const withDates = jobs.filter((j) => j.starts_at && amountOf(j) >= 0);

  const bounds = periodBounds(period, customStart, customEnd);
  const inSelected = withDates.filter((j) => {
    if (!bounds) return true; // all time
    const d = new Date(j.starts_at);
    return d >= bounds[0] && d < bounds[1];
  });

  const total = inSelected.reduce((sum, j) => sum + amountOf(j), 0);

  // Breakdown buckets within the selected period.
  const granularity = bucketGranularity(period);
  const buckets = {};
  const orderedKeys = [];
  for (const job of inSelected) {
    const key = bucketKey(job.starts_at, granularity);
    if (!buckets[key]) {
      buckets[key] = { total: 0, count: 0 };
      orderedKeys.push(key);
    }
    buckets[key].total += amountOf(job);
    buckets[key].count += 1;
  }

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";

  return (
    <div className="income">
      <div className="income__head">
        <h1 className="income__title">Income</h1>
      </div>

      <div className="income__periods">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            className={`income__period-btn ${period === p.key ? "income__period-btn--active" : ""}`}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {period === "custom" && (
        <div className="income__custom">
          <DatePicker
            selectsRange
            startDate={customStart}
            endDate={customEnd}
            onChange={([start, end]) => {
              setCustomStart(start);
              setCustomEnd(end);
            }}
            dateFormat="MMM d, yyyy"
            placeholderText="Pick a day or date range"
            className="income__dateinput"
            isClearable
            withPortal
            shouldCloseOnSelect={false}
          />
        </div>
      )}

      {error && <p className="income__error">{error}</p>}

      <div className="income__total">
        <span className="income__total-label">
          {period === "all" ? "Total collected" : `${periodLabel} income`}
        </span>
        <span className="income__total-amount">${total.toLocaleString()}</span>
        <span className="income__total-count">{inSelected.length} completed jobs</span>
      </div>

      {orderedKeys.length === 0 ? (
        <p className="income__empty">
          {period === "custom" && !bounds
            ? "Pick a day or range to see income."
            : "No completed jobs in this period."}
        </p>
      ) : (
        <div className="income__list">
          {orderedKeys.map((key) => (
            <div className="income__row" key={key}>
              <div className="income__row-label">
                <span className="income__period-name">{key}</span>
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