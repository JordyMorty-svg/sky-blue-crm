import { useEffect, useMemo, useState } from "react";
import ViewSwitcher from "../../components/ViewSwitcher";
import { INCOME_VIEWS } from "../../components/navViews";
import { money } from "../../services/commissionService";
import {
  INCOME_COLUMNS,
  NEC_THRESHOLD,
  PAYOUT_COLUMNS,
  REP_COLUMNS,
  availableYears,
  downloadCsv,
  fetchCompletedJobsForTax,
  fetchPaidCommissions,
  incomeRows,
  monthlyIncome,
  payoutRows,
  payoutsByRep,
  repCsvRows,
  summariseIncome,
  toCsv,
} from "../../services/taxService";
import "./TaxExport.css";

/**
 * The page you open in March, not in August.
 *
 * It answers two questions and refuses the third. What did we take in, and
 * what did we pay out to people who aren't us — those it can answer, because
 * the CRM is where both of those numbers already live. What did we SPEND it
 * does not answer, and the note at the bottom says so out loud rather than
 * letting the absence read as a zero.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default function TaxExport() {
  const [jobs, setJobs] = useState([]);
  const [commissions, setCommissions] = useState([]);
  // What the person clicked. The year actually rendered is derived from this
  // below, once we know which years have anything in them.
  const [wantedYear, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [j, c] = await Promise.all([
          fetchCompletedJobsForTax(),
          fetchPaidCommissions(),
        ]);
        if (cancelled) return;
        setJobs(j);
        setCommissions(c);
        setError("");
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load the year's figures.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(
    () => availableYears(jobs, commissions),
    [jobs, commissions]
  );

  // If the year in state isn't among the ones with data, fall through to the
  // newest that is — opening on an empty year reads as "the export is
  // broken". Derived during render rather than corrected in an effect: an
  // effect would render the wrong year once, then re-render, and there is
  // nothing here to synchronise with an external system.
  const year = years.includes(wantedYear) ? wantedYear : years[0] ?? wantedYear;

  const income = useMemo(() => incomeRows(jobs, year), [jobs, year]);
  const totals = useMemo(() => summariseIncome(income), [income]);
  const months = useMemo(() => monthlyIncome(income), [income]);
  const payouts = useMemo(() => payoutRows(commissions, year), [commissions, year]);
  const reps = useMemo(() => payoutsByRep(payouts), [payouts]);

  const owed1099 = reps.filter((r) => r.needs_1099);
  const peakMonth = Math.max(1, ...months.map((m) => m.collected));

  if (loading) return <div className="tax__state">Loading…</div>;

  function download(name, columns, rows) {
    downloadCsv(`sky-blue-${name}-${year}.csv`, toCsv(columns, rows));
  }

  return (
    <div className="tax">
      <ViewSwitcher views={INCOME_VIEWS} section="income" />
      <h1 className="visually-hidden">Tax export</h1>

      {error && <p className="tax__error">{error}</p>}

      <div className="tax__years">
        {years.map((y) => (
          <button
            key={y}
            className={`tax__year ${y === year ? "tax__year--active" : ""}`}
            onClick={() => setYear(y)}
          >
            {y}
          </button>
        ))}
      </div>

      {/* --- what came in --- */}

      <section className="tax__block">
        <div className="tax__blockhead">
          <h2 className="tax__h2">Money in</h2>
          <button
            className="tax__dl"
            onClick={() => download("income", INCOME_COLUMNS, income)}
            disabled={income.length === 0}
          >
            Download {income.length} jobs
          </button>
        </div>

        <div className="tax__figures">
          <div className="tax__figure">
            <span className="tax__figlabel">Collected</span>
            <span className="tax__figvalue">{money(totals.collected)}</span>
            <span className="tax__fignote">{totals.jobs} completed jobs</span>
          </div>
          {/* Only shown when there is something to show. A permanent "$0.00
              outstanding" tile trains you to stop reading it, which is the
              opposite of what a receivable needs. */}
          {totals.outstanding > 0 && (
            <div className="tax__figure tax__figure--warn">
              <span className="tax__figlabel">Finished, not collected</span>
              <span className="tax__figvalue">{money(totals.outstanding)}</span>
              <span className="tax__fignote">
                Marked complete with no payment recorded
              </span>
            </div>
          )}
        </div>

        {income.length > 0 && (
          <>
            <div className="tax__months">
              {months.map((m, i) => (
                <div className="tax__month" key={MONTHS[i]}>
                  <div className="tax__bartrack">
                    <div
                      className="tax__bar"
                      style={{ height: `${(m.collected / peakMonth) * 100}%` }}
                    />
                  </div>
                  <span className="tax__monthname">{MONTHS[i]}</span>
                  <span className="tax__monthval">
                    {m.collected > 0 ? `$${Math.round(m.collected / 100) / 10}k` : "—"}
                  </span>
                </div>
              ))}
            </div>
            <p className="tax__hint">
              Check these months against the deposits on the business account.
              A month that disagrees means something was collected and never
              recorded here — which you want to find now, not later.
            </p>
          </>
        )}
      </section>

      {/* --- what went out to other people --- */}

      <section className="tax__block">
        <div className="tax__blockhead">
          <h2 className="tax__h2">Paid to reps</h2>
          <div className="tax__dlgroup">
            <button
              className="tax__dl"
              onClick={() => download("1099-summary", REP_COLUMNS, repCsvRows(reps))}
              disabled={reps.length === 0}
            >
              Per person
            </button>
            <button
              className="tax__dl tax__dl--ghost"
              onClick={() => download("payouts", PAYOUT_COLUMNS, payouts)}
              disabled={payouts.length === 0}
            >
              Every line
            </button>
          </div>
        </div>

        <p className="tax__hint tax__hint--tight">
          Counted by the date the money was actually marked paid, not the date
          it was earned — that is what a 1099-NEC reports. A fee earned in
          December and paid in January belongs to the next year, so this will
          not match the Commission tab, and it isn&rsquo;t meant to.
        </p>

        {reps.length === 0 ? (
          <p className="tax__empty">
            Nothing was marked paid in {year}. Commissions only appear here
            once you press <b>Mark paid</b> on the Commission tab.
          </p>
        ) : (
          <>
            <table className="tax__table">
              <thead>
                <tr>
                  <th>Paid to</th>
                  <th className="tax__narrowhide">Payments</th>
                  <th className="tax__num">Total</th>
                  <th>1099-NEC</th>
                </tr>
              </thead>
              <tbody>
                {reps.map((r) => (
                  <tr key={r.profile_id || r.rep}>
                    <td>
                      <span className="tax__rep">{r.rep}</span>
                      <span className="tax__reprole">{r.role}</span>
                    </td>
                    <td className="tax__muted tax__narrowhide">{r.payments}</td>
                    <td className="tax__num tax__amount">{money(r.total)}</td>
                    <td>
                      {r.needs_1099 ? (
                        <span className="tax__flag tax__flag--due">Required</span>
                      ) : (
                        <span className="tax__flag">
                          Under ${NEC_THRESHOLD}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {owed1099.length > 0 && (
              <p className="tax__callout">
                <b>
                  {owed1099.length === 1
                    ? "One 1099-NEC is due"
                    : `${owed1099.length} 1099-NECs are due`}{" "}
                  by January 31, {year + 1}
                </b>{" "}
                — to {owed1099.map((r) => r.rep).join(", ")}, and to the IRS.
                You need a signed W-9 from each of them first, and it should
                already be on file before the next payment goes out.
              </p>
            )}
          </>
        )}
      </section>

      {/* The honest caveat. Without it this page reads like a tax return. */}
      <p className="tax__foot">
        This is revenue and contractor payouts only. It knows nothing about
        what you spent — fuel, mileage, supplies, ladders, insurance, hosting,
        Square&rsquo;s fees — and those are what bring the taxable number down.
        They belong in a bank feed and a bookkeeping app, not in here. Hand
        your accountant these files alongside that, not instead of it.
      </p>
    </div>
  );
}
