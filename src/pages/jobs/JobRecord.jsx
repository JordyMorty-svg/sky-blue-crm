import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { fetchJobRecord } from "../../services/jobService";
import { refreshInvoiceOnJob } from "../../services/invoiceService";
import { updateJobTiming } from "../../services/calendarService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import { planFor } from "../../services/leadService";
import JobPlanTag from "../../components/JobPlanTag";
import JobHistory from "../../components/JobHistory";
import { PAYMENT_LABELS, money, formatStamp } from "../../components/jobFormat";
import "./JobRecord.css";

/**
 * What happened on a finished job.
 *
 * Read-only on purpose. A completed job is a record of work done and money
 * taken — editing the price after the fact would quietly rewrite the Income
 * page, and there's a payment in Square that no longer matches. Corrections
 * belong in a note, not in the numbers.
 */

// Square's own vocabulary, said the way you'd say it out loud.
const INVOICE_STATUS_LABELS = {
  DRAFT: "Not sent yet",
  UNPAID: "Sent, not paid yet",
  SCHEDULED: "Scheduled to send",
  PARTIALLY_PAID: "Part-paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Paid, partly refunded",
  REFUNDED: "Refunded",
  CANCELED: "Cancelled",
  FAILED: "Payment failed",
  PAYMENT_PENDING: "Payment clearing",
};

function formatWhen(iso) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function JobRecord() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();

  // Whoever linked here says where "back" goes. Jobs board is the default.
  const returnTo = state?.from || "/jobs";
  const returnLabel = returnTo.startsWith("/customers")
    ? "← Back to customer"
    : returnTo.startsWith("/income")
      ? "← Back to income"
      : returnTo.startsWith("/schedule")
        ? "← Back to schedule"
        : "← Back to jobs";

  const [job, setJob] = useState(null);
  // Bumped to make JobHistory refetch — after a re-date, which writes an
  // event of its own. The component owns its data; this just pokes it.
  const [historyKey, setHistoryKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  // Re-dating a finished job. Deliberately behind a click rather than sat
  // on the page: this is the one number here that moves money between
  // months in the income report.
  const [redating, setRedating] = useState(false);
  const [newDate, setNewDate] = useState(null);
  const [newTime, setNewTime] = useState("");
  const [savingDate, setSavingDate] = useState(false);
  const [dateError, setDateError] = useState("");

  // Ask Square whether an invoice has been paid, and write the answer back.
  // Best-effort: this is a display refresh, so Square being unreachable
  // shows a note rather than breaking the page.
  async function syncInvoice(current) {
    if (!current?.square_invoice_id) return current;
    setChecking(true);
    setCheckError("");
    try {
      const fresh = await refreshInvoiceOnJob(current);
      if (fresh?.changed) {
        return { ...current, ...fresh.changes };
      }
      return current;
    } catch (e) {
      console.error(e);
      setCheckError(e.message || "Couldn't check with Square.");
      return current;
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchJobRecord(id);
        setError("");
        // The history loads itself inside JobHistory, and fails quietly
        // there if the migration hasn't been run — it's context, not the
        // record, and must never take this page down with it.
        //
        // The stored status is a snapshot from when the invoice was sent.
        // Anything not already settled is worth re-checking on open —
        // that's the whole window in which it can have been paid without
        // the CRM hearing about it.
        setJob(data.paid ? data : await syncInvoice(data));
      } catch (e) {
        console.error(e);
        setError("Couldn't load this job.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleRecheck() {
    setJob(await syncInvoice(job));
  }

  function startRedate() {
    const { date, time } = splitFromISO(job.starts_at);
    setNewDate(date);
    setNewTime(time);
    setDateError("");
    setRedating(true);
  }

  // Only the timing changes. The price, the payment and the receipt are
  // what actually happened and are left alone — this is for the case where
  // the work was logged on the wrong day, not for rewriting the job.
  async function handleSaveDate() {
    if (!newDate || !newTime) {
      setDateError("Pick a date and a time.");
      return;
    }
    setSavingDate(true);
    setDateError("");
    try {
      const startsAt = combineToISO(newDate, newTime);
      await updateJobTiming(job.id, {
        starts_at: startsAt,
        duration_hours: job.duration_hours,
      });
      setJob({ ...job, starts_at: startsAt });
      setRedating(false);
      // The move is itself a recorded event — pick it up rather than
      // leaving the history a step behind what's on screen.
      setHistoryKey((k) => k + 1);
    } catch (e) {
      console.error(e);
      setDateError(e.message || "Couldn't change the date.");
    } finally {
      setSavingDate(false);
    }
  }

  if (loading) return <div className="jobrec__state">Loading…</div>;
  if (!job) return <div className="jobrec__state">{error || "Not found."}</div>;

  const name = job.customer?.name || job.lead?.name || "Customer";
  const address = job.customer?.address || job.lead?.address || "";
  const crew = (job.assignments || [])
    .map((a) => a.tech?.full_name)
    .filter(Boolean);

  const quoted = Number(job.price ?? 0);
  const charged = Number(job.final_price ?? job.price ?? 0);
  const diff = charged - quoted;

  const method = job.payment_method;
  const methodLabel = PAYMENT_LABELS[method] || method || "Not recorded";
  const isInvoice = method === "invoice" && !!job.square_invoice_id;

  // An emailed invoice completes the job but isn't money in the bank until
  // the customer pays it — say so rather than showing a bare "unpaid".
  const awaitingInvoice = method === "invoice" && !job.paid;

  const plan = job.service_plan || "one_time";
  const isPlanVisit = plan !== "one_time";

  return (
    <div className="jobrec">
      <button className="jobrec__back" onClick={() => navigate(returnTo)}>
        {returnLabel}
      </button>

      {error && <p className="jobrec__error">{error}</p>}

      <div className="jobrec__head">
        <div>
          <h1 className="jobrec__title">{name}</h1>
          {address && <p className="jobrec__address">{address}</p>}
        </div>
        <span className={`jobrec__status jobrec__status--${job.status}`}>
          {job.status === "completed" ? "Completed" : job.status}
        </span>
      </div>

      <div className="jobrec__amount">
        <span className="jobrec__amount-num">{money(charged)}</span>
        <span className="jobrec__amount-label">
          {checking
            ? "checking with Square…"
            : awaitingInvoice
              ? "invoiced — awaiting payment"
              : job.paid
                ? `paid by ${methodLabel.toLowerCase()}`
                : "not recorded as paid"}
        </span>

        {/* An invoice's status lives in Square, not here — the CRM only
            ever saw it at the moment it was emailed. Offer a re-check
            rather than a "mark as paid" that could disagree with Square. */}
        {isInvoice && !checking && (
          <button
            className="jobrec__recheck"
            onClick={handleRecheck}
            title="Ask Square whether this invoice has been paid"
          >
            Re-check
          </button>
        )}
      </div>

      {checkError && <p className="jobrec__checkerror">{checkError}</p>}

      {job.completed_at && (
        <p className="jobrec__submitted">
          Submitted {formatStamp(job.completed_at)}
        </p>
      )}

      <dl className="jobrec__facts">
        <div className="jobrec__fact">
          <dt>When</dt>
          <dd className="jobrec__fact-when">
            <span>{formatWhen(job.starts_at)}</span>
            {!redating && (
              <button className="jobrec__redate" onClick={startRedate}>
                Change
              </button>
            )}
          </dd>
        </div>

        {redating && (
          <div className="jobrec__redatebox">
            <AppointmentPicker
              date={newDate}
              time={newTime}
              onDateChange={setNewDate}
              onTimeChange={setNewTime}
            />
            <p className="jobrec__redatewarn">
              Moving a completed job moves its <strong>${money(charged)}</strong>{" "}
              with it — the Income page reports revenue by the day the job
              sits on, so this changes which month it lands in. The payment
              in Square is not affected.
            </p>
            {dateError && <p className="jobrec__redateerr">{dateError}</p>}
            <div className="jobrec__redateactions">
              <button
                className="jobrec__redatesave"
                onClick={handleSaveDate}
                disabled={savingDate}
              >
                {savingDate ? "Saving…" : "Move the job"}
              </button>
              <button
                className="jobrec__redatecancel"
                onClick={() => setRedating(false)}
                disabled={savingDate}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="jobrec__fact">
          <dt>Work</dt>
          <dd>
            {job.services || "Window cleaning"}
            {job.duration_hours ? ` · ${job.duration_hours}h` : ""}
          </dd>
        </div>
        <div className="jobrec__fact">
          <dt>Crew</dt>
          <dd>{crew.length ? crew.join(", ") : "Not recorded"}</dd>
        </div>
        <div className="jobrec__fact">
          <dt>Plan</dt>
          <dd className="jobrec__fact-plan">
            <JobPlanTag job={job} />
            {isPlanVisit && (
              <span className="jobrec__facthint">
                every {planFor(plan).months} months
              </span>
            )}
          </dd>
        </div>
        <div className="jobrec__fact">
          <dt>Quoted</dt>
          <dd>
            {money(quoted)}
            {diff !== 0 && (
              <span
                className={`jobrec__diff ${
                  diff > 0 ? "jobrec__diff--up" : "jobrec__diff--down"
                }`}
              >
                {diff > 0
                  ? `upsold ${money(diff)}`
                  : `${money(Math.abs(diff))} under quote`}
              </span>
            )}
          </dd>
        </div>
        <div className="jobrec__fact">
          <dt>Paid by</dt>
          <dd>{methodLabel}</dd>
        </div>
      </dl>

      {job.notes && (
        <div className="jobrec__notes">
          <span className="jobrec__notes-label">Notes</span>
          <p className="jobrec__notes-text">{job.notes}</p>
        </div>
      )}

      <JobHistory jobId={job.id} refreshKey={historyKey} />

      <h2 className="jobrec__subhead">Paperwork</h2>

      {/* Square hosts both of these. They're the exact document the
          customer received, and both print to PDF from the browser, so
          there's nothing for the CRM to generate. */}
      {job.receipt_url && (
        <a
          className="jobrec__doc"
          href={job.receipt_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="jobrec__doc-main">
            <strong>Square receipt</strong>
            <span>The receipt for this card payment. Opens in Square.</span>
          </span>
          <span className="jobrec__doc-go">View ↗</span>
        </a>
      )}

      {job.invoice_url && (
        <a
          className="jobrec__doc"
          href={job.invoice_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="jobrec__doc-main">
            <strong>Square invoice</strong>
            <span>
              {job.invoice_status
                ? `${INVOICE_STATUS_LABELS[job.invoice_status] || job.invoice_status}. `
                : ""}
              Has a Download PDF button of its own.
            </span>
          </span>
          <span className="jobrec__doc-go">View ↗</span>
        </a>
      )}

      {!job.receipt_url && !job.invoice_url && (
        <p className="jobrec__nodoc">
          {method === "cash" || method === "check" ? (
            <>
              Cash and check payments have no Square document — the customer
              was emailed a receipt at the time, and this page is the record.
            </>
          ) : (
            <>
              No document on file. Card payments only started saving their
              Square receipt link recently, so jobs completed before that
              won't have one.
            </>
          )}
        </p>
      )}
    </div>
  );
}
