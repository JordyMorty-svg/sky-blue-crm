import { useEffect, useState } from "react";
import { fetchSquareInvoices, saveInvoiceOnJob } from "../services/invoiceService";
import { PAYMENT_LABELS, INVOICE_STATUS_SHORT, money } from "./jobFormat";
import "./RecordInvoiceModal.css";

/**
 * Record an invoice that was sent from Square, not by the CRM.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the only code path in the whole app that wrote
 * `jobs.square_invoice_id` was the completion flow — and that path does not
 * record an invoice, it CREATES and PUBLISHES a new one. So when Hayden sent
 * an invoice from the Square app himself, there was no way to tell the CRM
 * about it.
 *
 * On 30 Sep the id went into the Supabase table editor by hand, and because
 * the trigger inferred "we emailed the customer" from the column changing,
 * the history grew three "Invoice sent" rows for one invoice the CRM had
 * never sent. db/invoice-truth.sql stopped the history lying. This is the
 * other half: a door that is not the database.
 *
 * TWO WAYS IN, ON PURPOSE
 * -----------------------
 * The list is the default because a list cannot be mistyped. The manual box
 * is behind a link for the cases the list cannot serve — an invoice older
 * than the page, a different Square location, or Square being unreachable
 * from a driveway. Hiding it entirely would just send somebody back to the
 * table editor, which is the thing this is replacing.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never claims the CRM emailed anything. `emailed` is left at its default
 * of false, so the history says "Invoice recorded on the job" — which is the
 * only thing that actually happened here. Only the completion flow, which
 * has just watched Square publish, is allowed to say otherwise.
 */

// Only the methods that mean money actually arrived. "invoice" is absent
// deliberately: it means a bill went out and nothing was collected, so
// offering it as a correction on a job that has been PAID would be offering
// to make the record wrong.
const METHOD_CHOICES = ["cash", "check", "card", "tap", "square"];

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function RecordInvoiceModal({
  job,
  onClose,
  onSaved,
  // When given, the modal hands the chosen invoice back INSTEAD of saving
  // it. The completion flow needs this: there, the job has not been
  // completed yet, and completing is what sets paid and payment_method. If
  // the modal attached the invoice first, a job that was never completed
  // would be carrying one. So the record page lets the modal save, and the
  // completion flow takes the pick and completes-then-attaches in the order
  // finalize() already gets right.
  onPick = null,
  // Injected by the tests so the picker can be exercised without a network.
  // Defaulted rather than required, so a caller cannot accidentally wire it
  // to something that quietly returns nothing.
  loadInvoices = fetchSquareInvoices,
  save = saveInvoiceOnJob,
}) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [manual, setManual] = useState(false);
  const [typedId, setTypedId] = useState("");
  const [chosen, setChosen] = useState(null);
  const [method, setMethod] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Gated on COMPLETED, not on paid.
  //
  // The first version asked `job.paid`, on the reasoning that an unpaid job
  // has no payment to correct. That was wrong, and Jeff Krueger's job is
  // exactly why: completed, invoiced through Square, and the ACH takes days
  // to settle on a transfer that size — so Square says UNPAID and the CRM
  // agrees. Meanwhile the method still says `cash`, which was never true and
  // is knowably wrong TODAY.
  //
  // How the money is arriving and whether it has arrived are two different
  // facts. The method is known at completion; settlement happens later and
  // fixes itself when Square is re-checked. Gating the one on the other hid
  // the correction on precisely the job that needed it.
  const canCorrectMethod = job?.status === "completed";
  const currentMethod = job?.payment_method || null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const data = await loadInvoices({ limit: 25 });
        if (!cancelled) setInvoices(data?.invoices || []);
      } catch (e) {
        // Falling back to the manual box rather than showing a dead screen.
        // Square being unreachable is not a reason to make somebody open the
        // database.
        if (!cancelled) {
          setLoadError(e.message || "Couldn't reach Square.");
          setManual(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadInvoices]);

  async function handleSave() {
    setError("");

    const invoiceId = manual ? typedId.trim() : chosen?.invoiceId;
    if (!invoiceId) {
      setError(
        manual ? "Paste the Square invoice id." : "Pick which invoice this is."
      );
      return;
    }

    const picked = {
      invoiceId,
      publicUrl: manual ? null : chosen?.publicUrl || null,
      status: manual ? null : chosen?.status || null,
    };

    // Hand it back rather than saving — see onPick above.
    if (onPick) {
      onPick(picked);
      return;
    }

    setSaving(true);
    try {
      await save(
        job.id,
        picked,
        {
          // NOT emailed. Square sent this one; the CRM did not, and the
          // history has to be able to tell those apart.
          emailed: false,
          // Only when it was actually changed. An untouched control sends
          // nothing, and the database leaves the column alone.
          paymentMethod: method && method !== currentMethod ? method : null,
        }
      );
      onSaved?.();
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't record that invoice.");
      setSaving(false);
    }
  }

  const customer = job?.lead?.name || job?.customer?.name || "this job";

  return (
    <div className="recinv__backdrop" onClick={onClose}>
      <div
        className="recinv"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Record a Square invoice for ${customer}`}
      >
        <h2 className="recinv__title">Record an invoice from Square</h2>
        <p className="recinv__sub">
          For an invoice sent from the Square app. The customer is not emailed
          again — this only tells the CRM it exists.
        </p>

        {loading && <p className="recinv__muted">Asking Square…</p>}

        {loadError && (
          <p className="recinv__warn">
            {loadError} You can still paste the invoice id below.
          </p>
        )}

        {!loading && !manual && (
          <>
            {invoices.length === 0 ? (
              <p className="recinv__muted">
                Square has no sent invoices to show.
              </p>
            ) : (
              <ul className="recinv__list">
                {invoices.map((inv) => (
                  <li key={inv.invoiceId}>
                    <button
                      type="button"
                      className={
                        "recinv__row" +
                        (chosen?.invoiceId === inv.invoiceId
                          ? " recinv__row--on"
                          : "")
                      }
                      onClick={() => setChosen(inv)}
                      aria-pressed={chosen?.invoiceId === inv.invoiceId}
                    >
                      <span className="recinv__who">
                        {inv.customerName || "No name on the invoice"}
                      </span>
                      <span className="recinv__meta">
                        {inv.invoiceNumber ? `#${inv.invoiceNumber} · ` : ""}
                        {money(inv.amount)}
                        {inv.createdAt ? ` · ${shortDate(inv.createdAt)}` : ""}
                      </span>
                      <span
                        className={
                          "recinv__status" +
                          (inv.paid ? " recinv__status--paid" : "")
                        }
                      >
                        {INVOICE_STATUS_SHORT[inv.status] || inv.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              className="recinv__switch"
              onClick={() => setManual(true)}
            >
              Not listed — paste the id instead
            </button>
          </>
        )}

        {manual && (
          <>
            <label className="recinv__label" htmlFor="recinv-id">
              Square invoice id
            </label>
            <input
              id="recinv-id"
              className="recinv__input"
              value={typedId}
              onChange={(e) => setTypedId(e.target.value)}
              placeholder="inv:0-ChCX…"
              autoComplete="off"
              spellCheck="false"
            />
            <p className="recinv__hint">
              In Square: open the invoice, and it's the long id at the end of
              the address bar.
            </p>

            {!loadError && (
              <button
                type="button"
                className="recinv__switch"
                onClick={() => setManual(false)}
              >
                Pick from the list instead
              </button>
            )}
          </>
        )}

        {/* The payment-method correction.
            Only offered on a job that has already been PAID. On an unpaid
            job there is nothing to correct — the method is still being
            decided, and the completion flow is where that gets decided. */}
        {canCorrectMethod && (
          <>
            <label className="recinv__label" htmlFor="recinv-method">
              How it was actually paid
            </label>
            <select
              id="recinv-method"
              className="recinv__input"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="">
                Leave as {PAYMENT_LABELS[currentMethod] || currentMethod || "recorded"}
              </option>
              {METHOD_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_LABELS[m] || m}
                </option>
              ))}
            </select>
            <p className="recinv__hint">
              Worth fixing if this was paid through Square — that's what Square
              reports on the 1099-K, and the books should agree with it.
            </p>
          </>
        )}

        {error && <p className="recinv__error">{error}</p>}

        <div className="recinv__actions">
          <button
            type="button"
            className="recinv__save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Recording…" : "Record it"}
          </button>
          <button type="button" className="recinv__cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
