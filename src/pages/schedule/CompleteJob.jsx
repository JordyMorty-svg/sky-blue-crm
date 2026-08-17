import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchJob, completeJob } from "../../services/jobService";
import {
  createSquareInvoice,
  saveInvoiceOnJob,
  sendReceipt,
} from "../../services/invoiceService";
import {
  chargeCard,
  saveCardOnCustomer,
  savePaymentOnJob,
} from "../../services/paymentService";
import { updateCustomer } from "../../services/customerService";
import CardPaymentForm from "../../components/CardPaymentForm";
import "./CompleteJob.css";

const PAYMENT_METHODS = [
  { key: "cash", label: "Cash" },
  { key: "check", label: "Check" },
  { key: "card", label: "Card" },
  { key: "invoice", label: "Email invoice" },
];

// Methods that mean "paid in the field, right now" — these get a receipt
// email. "invoice" is the exception: Square emails that one itself.
// Historical jobs may still carry method "square" from before card
// payments moved in-app; nothing here needs to render those.
const RECEIPT_METHODS = ["cash", "check", "card"];

export default function CompleteJob() {
  const { jobId } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [finalPrice, setFinalPrice] = useState("");
  const [method, setMethod] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Set when the customer has a card on file but we want a different one.
  const [useNewCard, setUseNewCard] = useState(false);

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
      // Prefill email if we have one on file.
      setEmail(data.customer?.email || data.lead?.email || "");
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this job.");
    } finally {
      setLoading(false);
    }
  }

  const customerName =
    job?.lead?.name || job?.customer?.name || "Customer";
  const jobDescription =
    job?.services || `Window cleaning — ${job?.lead?.address || "service"}`;
  const savedCard = job?.customer?.square_card_id
    ? {
        id: job.customer.square_card_id,
        brand: job.customer.card_brand,
        last4: job.customer.card_last4,
        expMonth: job.customer.card_exp_month,
        expYear: job.customer.card_exp_year,
      }
    : null;

  const amountValid = finalPrice !== "" && Number(finalPrice) > 0;

  // Everything that happens once the money side is settled. Shared by all
  // payment methods so the job, the receipt, and the redirect stay in one
  // place.
  async function finalize({ invoice = null, payment = null } = {}) {
    await completeJob(job, {
      finalPrice: Number(finalPrice),
      paymentMethod: method,
      paymentNotes: notes.trim() || null,
    });

    // Record the invoice on the job (also marks paid=false until they pay).
    if (invoice) {
      await saveInvoiceOnJob(job.id, invoice);
    }

    // Record the payment, and remember the card for next time. Neither of
    // these should undo a successful charge — warn, don't block.
    if (payment) {
      try {
        await savePaymentOnJob(job.id, payment.paymentId);
        if (job.customer_id && (payment.squareCustomerId || payment.card)) {
          await saveCardOnCustomer(job.customer_id, payment);
        }
      } catch (saveErr) {
        console.error("Payment recorded in Square but not in the CRM:", saveErr);
      }
    }

    // If we collected or corrected an email at the door, keep it on the
    // customer so the next visit prefills it and invoices reach them.
    const typedEmail = email.trim();
    if (
      job.customer_id &&
      typedEmail &&
      typedEmail !== (job.customer?.email || "")
    ) {
      try {
        await updateCustomer(job.customer_id, { email: typedEmail });
      } catch (emailErr) {
        console.error("Couldn't save the email to the customer:", emailErr);
      }
    }

    // For paid methods, email a receipt if we have an address to send to.
    // Receipt failure shouldn't undo a completed job — warn, don't block.
    if (RECEIPT_METHODS.includes(method) && email.trim()) {
      try {
        await sendReceipt({
          customerName,
          customerEmail: email.trim(),
          amount: Number(finalPrice),
          method,
          description: jobDescription,
          address: job.lead?.address || job.customer?.address || "",
        });
      } catch (receiptErr) {
        console.error("Receipt failed (job still completed):", receiptErr);
      }
    }

    navigate("/schedule");
  }

  // Cash / check / square / invoice. Card has its own path below, because
  // the charge has to clear before anything else happens.
  async function handleComplete() {
    setError("");
    if (!amountValid) {
      setError("Enter the amount received.");
      return;
    }
    if (!method) {
      setError("Select a payment method.");
      return;
    }
    if (method === "invoice" && !email.trim()) {
      setError("An email address is needed to send the invoice.");
      return;
    }

    setSaving(true);
    try {
      let invoice = null;

      // Create the Square invoice FIRST — if it fails, we stop and the
      // job stays incomplete rather than completing with no invoice sent.
      if (method === "invoice") {
        invoice = await createSquareInvoice({
          customerName,
          customerEmail: email.trim(),
          amount: Number(finalPrice),
          description: jobDescription,
        });
      }

      await finalize({ invoice });
    } catch (e) {
      console.error(e);
      setError(
        method === "invoice"
          ? `Invoice problem: ${e.message}`
          : "Couldn't complete the job. Try again."
      );
      setSaving(false);
    }
  }

  // Shared by the new-card and saved-card paths: charge, then finalize.
  // Always throws on failure — each caller decides where to show the
  // message, so it doesn't get rendered twice.
  async function runCharge(chargeArgs) {
    setError("");
    if (!amountValid) {
      throw new Error("Enter the amount received before charging.");
    }

    setSaving(true);
    try {
      const payment = await chargeCard({
        amount: Number(finalPrice),
        customerName,
        customerEmail: email.trim() || undefined,
        customerPhone: job.lead?.phone || job.customer?.phone || undefined,
        squareCustomerId: job.customer?.square_customer_id || undefined,
        description: jobDescription,
        referenceId: job.id,
        ...chargeArgs,
      });

      if (payment.cardSaveFailed) {
        console.warn("Payment went through but the card wasn't saved.");
      }

      await finalize({ payment });
    } catch (e) {
      setSaving(false);
      throw e;
    }
  }

  // Fresh card typed into the Square form. Errors bubble up so the form
  // shows them right under the card fields.
  async function handleCardToken({ sourceId, saveCard }) {
    await runCharge({ sourceId, saveCard });
  }

  // Repeat customer — charge the card already on file.
  async function handleChargeSavedCard() {
    try {
      await runCharge({ savedCardId: savedCard.id });
    } catch (e) {
      console.error(e);
      setError(e.message || "That saved card couldn't be charged.");
    }
  }

  if (loading) return <div className="complete__state">Loading…</div>;
  if (!job) return <div className="complete__state">{error || "Not found."}</div>;

  const quoted = job.price ?? 0;
  const diff = finalPrice ? Number(finalPrice) - quoted : 0;
  const showSavedCard = method === "card" && savedCard && !useNewCard;
  const showCardForm = method === "card" && (!savedCard || useNewCard);

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

        {method === "invoice" && (
          <>
            <label className="complete__label">Customer email</label>
            <input
              className="complete__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@email.com"
            />
            <p className="complete__hint">
              Square will email an invoice they can pay online by card. The
              job records as completed but unpaid until they pay.
            </p>
          </>
        )}

        {RECEIPT_METHODS.includes(method) && (
          <>
            <label className="complete__label">
              Customer email <span className="complete__optional">(optional — for receipt)</span>
            </label>
            <input
              className="complete__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@email.com"
            />
            <p className="complete__hint">
              If provided, we'll email a receipt confirming this payment.
              Leave blank to skip.
            </p>
          </>
        )}

        {showSavedCard && (
          <>
            <label className="complete__label">Card on file</label>
            <div className="cardpay__saved">
              <span className="cardpay__savedcard">
                {savedCard.brand || "Card"} ····{savedCard.last4}
                {savedCard.expMonth && savedCard.expYear && (
                  <span className="cardpay__savedexp">
                    Expires {String(savedCard.expMonth).padStart(2, "0")}/
                    {String(savedCard.expYear).slice(-2)}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="cardpay__swap"
                onClick={() => setUseNewCard(true)}
              >
                Use a different card
              </button>
            </div>
            <button
              type="button"
              className="cardpay__charge"
              onClick={handleChargeSavedCard}
              disabled={saving || !amountValid}
            >
              {saving
                ? "Charging…"
                : `Charge $${Number(finalPrice || 0).toFixed(2)} to ····${savedCard.last4}`}
            </button>
          </>
        )}

        {showCardForm && (
          <>
            {savedCard && (
              <button
                type="button"
                className="cardpay__swap"
                onClick={() => setUseNewCard(false)}
              >
                ← Use the card on file instead
              </button>
            )}
            <CardPaymentForm
              amount={Number(finalPrice || 0)}
              customerName={customerName}
              customerEmail={email.trim()}
              onToken={handleCardToken}
              disabled={saving || !amountValid}
            />
          </>
        )}

        <label className="complete__label">Notes (optional)</label>
        <textarea
          className="complete__input complete__textarea"
          rows="2"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Upsold gutter cleaning, etc."
        />

        <div className="complete__actions">
          {/* Card completes via the charge button above — the job is only
              finished once the money actually clears. */}
          {method !== "card" && (
            <button
              className="complete__submit"
              onClick={handleComplete}
              disabled={saving}
            >
              {saving ? "Completing…" : "Complete job"}
            </button>
          )}
          <button className="complete__cancel" onClick={() => navigate("/schedule")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
