import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { fetchJob, completeJob, setJobPlan } from "../../services/jobService";
import {
  createSquareInvoice,
  saveInvoiceOnJob,
  sendReceipt,
} from "../../services/invoiceService";
import {
  chargeCard,
  saveCardOnCustomer,
  savePaymentOnJob,
  resolvePosPayment,
  findPosPayment,
} from "../../services/paymentService";
import {
  buildPosUrl,
  canUseSquarePos,
  isStandalonePWA,
  jobCode,
  readChasablePayment,
  clearPendingPayment,
  rememberPendingPayment,
} from "../../components/squarePos";
import {
  updateCustomer,
  applyPlanFromJob,
} from "../../services/customerService";
import CardPaymentForm from "../../components/CardPaymentForm";
import PlanPicker from "../../components/PlanPicker";
import { planFor } from "../../services/leadService";
import "./CompleteJob.css";

// "tap" and "card" are both card payments and both record as method
// "card" — the difference is only in how the card is read, and that
// difference is worth surfacing because it's priced very differently.
// A tap is an in-person transaction (2.6% + 15c at time of writing);
// typing the number in is card-not-present (3.5% + 15c).
//
// `settled` is the important one. Four of these mean money is in hand.
// "invoice" means the opposite: nothing has been collected and the
// customer is about to be emailed a bill. Listing it as a fifth peer is
// what let a check get invoiced by mistake — same size button, same row,
// and the word "email" appears in the receipt flow too. It's separated
// out below a divider for that reason, not for tidiness.
const PAYMENT_METHODS = [
  { key: "cash", label: "Cash", blurb: "Money in hand", settled: true },
  { key: "check", label: "Check", blurb: "Money in hand", settled: true },
  {
    key: "tap",
    label: "Tap card",
    blurb: "Contactless, in the Square app",
    hint: "cheapest",
    posOnly: true,
    settled: true,
  },
  {
    key: "card",
    label: "Type card number",
    blurb: "Costs more than tapping",
    settled: true,
  },
  {
    key: "invoice",
    label: "Email an invoice",
    blurb: "Sends the customer a bill to pay online. Nothing is collected now.",
    settled: false,
  },
];

// Methods that mean "paid in the field, right now" — these get a receipt
// email. "invoice" is the exception: Square emails that one itself.
// Historical jobs may still carry method "square" from before card
// payments moved in-app; nothing here needs to render those.
const RECEIPT_METHODS = ["cash", "check", "card"];

export default function CompleteJob() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  // Set when we've just come back from the Square app via PosReturn.
  const { state: navState } = useLocation();

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
  // Plan can be set right here — "yes, put me on quarterly" usually gets
  // said while you're packing up, and this is the last chance before the
  // next visit is generated.
  const [propertyType, setPropertyType] = useState("residential");
  const [servicePlan, setServicePlan] = useState("one_time");
  // True while we're resolving a tap that already happened in Square.
  const [settling, setSettling] = useState(false);
  // True while we're asking Square whether a tap went through at all.
  const [chasing, setChasing] = useState(false);
  // A hand-off that started but hasn't been accounted for yet.
  const [unfinished, setUnfinished] = useState(null);
  const [chaseNote, setChaseNote] = useState("");

  const posAvailable = canUseSquarePos();
  const handOffLeavesApp = isStandalonePWA();

  async function load() {
    try {
      const data = await fetchJob(jobId);
      setJob(data);
      // Default the amount to the quoted price — editable for upsells.
      setFinalPrice(data.price ?? "");
      // Prefill email if we have one on file.
      setEmail(data.customer?.email || data.lead?.email || "");
      setPropertyType(
        data.customer?.property_type || data.property_type || "residential"
      );
      setServicePlan(
        data.customer?.service_plan || data.service_plan || "one_time"
      );
      setError("");
      return data;
    } catch (e) {
      console.error(e);
      setError("Couldn't load this job.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      const data = await load();
      // Coming back from a tap: the money is already taken, so the only
      // thing left is to record it. Do that automatically rather than
      // making someone press Complete again on a job that's paid for.
      if (data && navState?.posResult?.transactionId) {
        await settleTappedPayment(data, navState.posResult, navState.pending);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

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

  // What's currently on screen, in one object, so finalize can be handed a
  // different set of values without a second copy of the completion logic.
  const onScreen = {
    job,
    finalPrice,
    method,
    notes,
    email,
    servicePlan,
    propertyType,
  };

  // Everything that happens once the money side is settled. Shared by all
  // payment methods so the job, the receipt, and the redirect stay in one
  // place.
  //
  // `ctx` overrides what's on screen. Every method except the tap hand-off
  // leaves it empty and works off component state. The tap path can't:
  // it returns from another app into a freshly-mounted page, so the values
  // come from what was stashed before leaving rather than from state that
  // was set moments ago and hasn't rendered yet.
  async function finalize({ invoice = null, payment = null, ctx = {} } = {}) {
    // Deliberate shadowing: the names below are the same as the component's
    // state, so the body reads identically whichever path called it.
    // `onScreen` was captured in the outer scope, so it still holds state.
    const {
      job,
      finalPrice,
      method,
      notes,
      email,
      servicePlan,
      propertyType,
    } = { ...onScreen, ...ctx };

    const customerName = job?.lead?.name || job?.customer?.name || "Customer";
    const jobDescription =
      job?.services || `Window cleaning — ${job?.lead?.address || "service"}`;

    // Save the plan first: completeJob generates the next visit from the
    // customer's plan, so writing it afterwards would be a cycle too late.
    // Only a job that's on a plan generates the next visit, so if the plan
    // was just set here the job has to carry it before completing. A copy
    // rather than a mutation — `job` is state.
    let jobToComplete = job;
    try {
      // An extra is deliberately outside the recurring cycle, so completing
      // it must not touch the plan at all.
      //
      // This is where the plan bug actually bit: the picker defaults to the
      // customer's current plan, so submitting an extra for a Quarterly
      // customer stamped the extra Quarterly, logged a "One-time ->
      // Quarterly" change against it, and generated a next visit from a job
      // that was never part of the cycle. Their plan lives on the customer
      // record and is already correct — there is nothing to save here.
      if (!job.is_extra) {
        await applyPlanFromJob(
          job.customer_id,
          { servicePlan, propertyType },
          job.customer
        );
        await setJobPlan(job.id, { servicePlan, propertyType });
        if (servicePlan && servicePlan !== "one_time") {
          jobToComplete = {
            ...job,
            service_plan: servicePlan,
            property_type: propertyType,
          };
        }
      }
    } catch (planErr) {
      console.error("Couldn't save the service plan:", planErr);
    }

    const { nextVisit } = await completeJob(jobToComplete, {
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
        await savePaymentOnJob(job.id, {
          paymentId: payment.paymentId,
          receiptUrl: payment.receiptUrl,
        });
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

    // Tell the schedule page what was booked, rather than the next visit
    // appearing out of nowhere on the Jobs board.
    navigate("/schedule", {
      state: nextVisit
        ? {
            nextVisit: {
              startsAt: nextVisit.starts_at,
              price: nextVisit.price,
              name: customerName,
            },
          }
        : undefined,
    });
  }

  // --- coming back from the Square app ---------------------------------
  //
  // Returning here means one of three things, and they need telling apart
  // before anything is offered to press:
  //
  //   1. The job was completed elsewhere. On an iOS home-screen install
  //      the callback lands in Safari and finishes the job there, leaving
  //      this copy of the page showing a live payment form for a job
  //      that's already paid. Press the button and the customer is charged
  //      twice — the worst thing this app can do.
  //   2. A tap was taken but nothing recorded it, because the callback
  //      never arrived. Square knows; ask it.
  //   3. Nothing happened — they backed out of Square. Carry on.
  //
  // Runs on every return to visibility rather than once on mount, because
  // the page is never unmounted during the hand-off.
  useEffect(() => {
    let cancelled = false;

    async function onReturn() {
      if (document.visibilityState !== "visible") return;
      if (!job || job.status !== "scheduled") return;

      let current = job;
      try {
        const fresh = await fetchJob(jobId);
        if (cancelled) return;
        current = fresh;
        if (fresh.status !== "scheduled") {
          // Case 1 — finished in the other window.
          clearPendingPayment();
          setUnfinished(null);
          setJob(fresh);
          return;
        }
      } catch (e) {
        // A failed re-check must not block a legitimate payment; the worst
        // case is the behaviour we had before this guard existed.
        console.error("Couldn't re-check the job status:", e);
      }

      // Cases 2 and 3 — still open, so see whether Square took money.
      const pending = readChasablePayment(jobId, Date.now());
      if (!pending?.code || cancelled) return;
      setUnfinished(pending);
      const done = await chaseTappedPayment(current, pending);
      if (done && !cancelled) setUnfinished(null);
    }

    document.addEventListener("visibilitychange", onReturn);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status]);

  // A hand-off from a previous visit to this page — the app was closed
  // before it could be settled. Surfaced so it can be chased by hand.
  useEffect(() => {
    if (!job || job.status !== "scheduled") return;
    const pending = readChasablePayment(jobId, Date.now());
    if (pending?.code) setUnfinished(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status]);

  // --- tap: hand off to the Square app ---------------------------------
  //
  // Leaving the browser tears this page down, so everything on screen is
  // written to storage first. If the tap succeeds Square returns to
  // /pos-return, which sends us back here with the transaction id.
  function handleTapCard() {
    setError("");
    if (!amountValid) {
      setError("Enter the amount before tapping a card.");
      return;
    }

    // `code` and `startedAt` are what make the payment findable later
    // without the callback: the code is stamped on the Square order, and
    // the time bounds the search.
    rememberPendingPayment({
      jobId: job.id,
      code: jobCode(job.id),
      startedAt: new Date().toISOString(),
      finalPrice: Number(finalPrice),
      notes,
      email,
      servicePlan,
      propertyType,
    });

    try {
      // location.href, not window.open: a popup would be blocked, and the
      // custom scheme has to be a top-level navigation to reach the app.
      window.location.href = buildPosUrl({
        amount: Number(finalPrice),
        jobId: job.id,
        note: `${customerName} — ${jobDescription}`,
        // Ride along in Square's `state` so a plan agreed at the door
        // survives even when the return lands in a different browser with
        // no access to what we just stored.
        servicePlan,
        propertyType,
      });
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't open Square.");
    }
  }

  // --- tap: record what Square already took ----------------------------
  //
  // The money is gone from the customer's card by the time we get here.
  // Everything below is bookkeeping, and none of it can un-charge them —
  // so a failure has to say "the payment worked, the record didn't"
  // rather than anything that reads like the charge failed.
  async function settleTappedPayment(jobRow, posResult, pending) {
    setSettling(true);
    try {
      const payment = await resolvePosPayment(posResult.transactionId);
      await recordTappedPayment(jobRow, payment, pending);
    } catch (e) {
      reportSettleFailure(e);
    }
  }

  // The half that writes the job away, shared by both routes to a tapped
  // payment: the callback, and the search that runs when the callback
  // never came.
  async function recordTappedPayment(jobRow, payment, pending) {
      // Square is the authority on what was actually charged. If the crew
      // changed the amount inside the Square app, that's the real figure.
      const amount = payment.amount || pending?.finalPrice || jobRow.price;

      // Prefer what was on screen before we left. When storage wasn't
      // available, fall back to the customer record — worse than the
      // operator's own input, but far better than blanks, which would
      // silently skip the receipt email.
      await finalize({
        payment,
        ctx: {
          job: jobRow,
          method: "card",
          finalPrice: amount,
          notes: pending?.notes ?? "",
          email:
            pending?.email ??
            (jobRow.customer?.email || jobRow.lead?.email || ""),
          servicePlan:
            pending?.servicePlan ??
            jobRow.customer?.service_plan ??
            jobRow.service_plan ??
            "one_time",
          propertyType:
            pending?.propertyType ??
            jobRow.customer?.property_type ??
            jobRow.property_type ??
            "residential",
        },
      });
    clearPendingPayment();
  }

  // Money moved, the record didn't. This wording matters: anything that
  // reads like the charge failed invites running the card a second time.
  function reportSettleFailure(e) {
    console.error(e);
    setError(
      `The card was charged in Square, but recording it here failed: ${
        e.message || "unknown error"
      } — the job is still open. Complete it as a card payment so your ` +
        "books match, and don't run the card again."
    );
    setSettling(false);
  }

  // --- tap: find a payment the callback never told us about -----------
  //
  // The callback is a browser redirect and redirects get lost. From an iOS
  // home-screen install it ALWAYS lands somewhere else, and anywhere else
  // it can still die with the tab. Since the card has already been charged
  // by that point, waiting to be told is the wrong default — ask Square.
  //
  // Returns true when a payment was found and recorded.
  async function chaseTappedPayment(jobRow, pending, { quiet = true } = {}) {
    setChasing(true);
    setChaseNote("");
    try {
      const found = await findPosPayment({
        code: pending.code,
        since: pending.startedAt,
      });

      if (!found.found) {
        setChasing(false);
        // Backing out of Square without paying is completely normal, so an
        // automatic check says nothing. A check the operator asked for
        // deserves an answer either way.
        if (!quiet) {
          setChaseNote(
            "No payment for this job in Square yet. If you did take one, " +
              "give it a moment and check again."
          );
        }
        return false;
      }

      setChasing(false);
      setSettling(true);
      await recordTappedPayment(jobRow, found, pending);
      return true;
    } catch (e) {
      console.error(e);
      setChasing(false);
      // Never silent on a genuine error: this runs precisely when money
      // may already have moved.
      setChaseNote(
        `Couldn't check Square: ${e.message || "unknown error"}. The job is ` +
          "still open — check the Square app before charging again."
      );
      return false;
    }
  }

  async function handleCheckSquare() {
    if (!unfinished || !job) return;
    const done = await chaseTappedPayment(job, unfinished, { quiet: false });
    if (done) setUnfinished(null);
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

  // The commit button says what it is about to do, not "Complete job".
  //
  // This is the safeguard that matters. Every other change here makes the
  // wrong option harder to pick; this one catches it after it's been
  // picked. Recording a check and emailing a customer a bill used to share
  // one button, one label and one colour — so the last thing on screen
  // before an invoice went out gave no hint that an email was involved.
  function submitLabel() {
    if (method === "invoice") {
      const to = email.trim();
      const amount = `$${Number(finalPrice || 0).toFixed(2)}`;
      if (saving) return "Sending the bill…";
      return to ? `Email a ${amount} bill to ${to}` : `Email a ${amount} bill`;
    }
    if (saving) return "Completing…";
    const picked = PAYMENT_METHODS.find((m) => m.key === method);
    return picked
      ? `Complete job — paid by ${picked.label.toLowerCase()}`
      : "Complete job";
  }

  // One row per option: name, an optional badge, and a line saying what
  // it means. The explanation is the point — "Check" and "Email an
  // invoice" are indistinguishable at a glance without it.
  function renderMethod(m) {
    const active = method === m.key;
    return (
      <button
        key={m.key}
        type="button"
        className={`complete__method ${active ? "complete__method--active" : ""} ${
          m.settled ? "" : "complete__method--unpaid"
        }`}
        onClick={() => setMethod(m.key)}
        aria-pressed={active}
      >
        <span className="complete__methodtop">
          <span className="complete__methodname">{m.label}</span>
          {m.hint && <span className="complete__methodhint">{m.hint}</span>}
        </span>
        <span className="complete__methodblurb">{m.blurb}</span>
      </button>
    );
  }

  if (loading) return <div className="complete__state">Loading…</div>;
  if (!job) return <div className="complete__state">{error || "Not found."}</div>;

  // Finished elsewhere — almost always the Safari half of a tap hand-off.
  // Show the outcome instead of a payment form nobody should use again.
  if (job.status && job.status !== "scheduled") {
    return (
      <div className="complete__state complete__done">
        <strong>This job is already completed.</strong>
        <span>
          It was finished in another window — most likely the browser Square
          returned to after the tap. Nothing more to do here.
        </span>
        <div className="complete__doneactions">
          <button
            className="complete__submit"
            onClick={() => navigate(`/jobs/record/${job.id}`)}
          >
            View the job record
          </button>
          <button
            className="complete__cancel"
            onClick={() => navigate("/schedule")}
          >
            Back to schedule
          </button>
        </div>
      </div>
    );
  }

  // Asking Square whether a tap went through. The form stays hidden while
  // we don't know — if the answer is yes, showing a payment button would
  // be inviting a second charge.
  if (chasing) {
    return (
      <div className="complete__state complete__settling">
        <div className="complete__spinner" aria-hidden="true" />
        <strong>Checking Square…</strong>
        <span>Seeing whether this job was already paid for.</span>
      </div>
    );
  }

  // Coming back from a successful tap. The charge already happened, so
  // there's nothing to press and nothing to reconsider — showing the form
  // again would invite someone to run the card a second time.
  if (settling) {
    return (
      <div className="complete__state complete__settling">
        <div className="complete__spinner" aria-hidden="true" />
        <strong>Card charged.</strong>
        <span>Recording the payment and finishing the job…</span>
      </div>
    );
  }

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

      {/* A tap was started for this job and nothing has accounted for it.
          Usually they backed out of Square, in which case carrying on is
          right — but if money did move, this is the way to find it without
          running the card again. */}
      {unfinished && (
        <div className="complete__unfinished">
          <strong>A card tap was started for this job.</strong>
          <span>
            If it went through, don't charge again — pull it in from Square
            instead.
          </span>
          <button
            type="button"
            className="complete__checkbtn"
            onClick={handleCheckSquare}
            disabled={chasing}
          >
            Check Square for the payment
          </button>
          {chaseNote && <span className="complete__chasenote">{chaseNote}</span>}
        </div>
      )}

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

        <label className="complete__label">How was this paid?</label>

        {/* Full width and stacked, never a wrapping grid. On a phone a
            wrapping row reflows unpredictably, so which option sits where
            depends on screen width — and one of these emails a customer. */}
        <div className="complete__methods">
          {PAYMENT_METHODS
            // Tapping needs the Square app, which only exists on a phone.
            // Hidden rather than disabled on a laptop — an option you can
            // never use is just clutter.
            .filter((m) => m.settled && (!m.posOnly || posAvailable))
            .map((m) => renderMethod(m))}
        </div>

        {/* Below the line, and labelled for what it actually is. */}
        <div className="complete__unpaid">
          <span className="complete__unpaidlabel">Not paid yet</span>
          {PAYMENT_METHODS.filter((m) => !m.settled).map((m) => renderMethod(m))}
        </div>

        {method === "tap" && (
          <div className="complete__tap">
            <p className="complete__taphint">
              Opens the Square app to take the tap, then comes back here and
              finishes the job on its own. Contactless card, Apple Pay and
              Google Pay all work.
            </p>
            <button
              type="button"
              className="complete__tapbtn"
              onClick={handleTapCard}
              disabled={saving || !amountValid}
            >
              Tap ${Number(finalPrice || 0).toFixed(2)} in Square
            </button>
            <p className="complete__tapnote">
              Needs Square Point of Sale installed and signed in on this
              phone. A tap is charged at the in-person rate — cheaper than
              typing the card number in.
            </p>

            {/* iOS sends the callback to Safari even when the CRM was
                opened from the home screen, and Safari is a separate login.
                Better said here than discovered mid-payment. */}
            {handOffLeavesApp && (
              <p className="complete__tapwarn">
                You're running the CRM from the home screen. Square sends you
                back through Safari, so the job gets finished there rather
                than in this window — and Safari will ask you to sign in the
                first time. The payment is never at risk either way.
              </p>
            )}
          </div>
        )}

        {method === "invoice" && (
          <>
            <label className="complete__label">Where to send the bill</label>
            <input
              className="complete__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@email.com"
            />
            <p className="complete__hint complete__hint--warn">
              Square emails them an invoice to pay online. The work records
              as done, but the money is <strong>not</strong> collected — the
              job stays unpaid until they pay it.
            </p>
          </>
        )}

        {/* "tap" records as a card payment, so it earns a receipt the same
            way — but it isn't in RECEIPT_METHODS, which is keyed on what
            gets stored rather than what's on screen. */}
        {(RECEIPT_METHODS.includes(method) || method === "tap") && (
          <>
            <label className="complete__label">
              Email a receipt to{" "}
              <span className="complete__optional">(optional)</span>
            </label>
            <input
              className="complete__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@email.com"
            />
            <p className="complete__hint">
              Confirms the payment you just took. This does not bill them
              for anything. Leave blank to skip.
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

        {/* No plan picker on an extra. It was booked as a one-off on top of
            an existing plan, and offering the control here is what made it
            easy to overwrite that plan by accident. */}
        {job.customer_id && job.is_extra && (
          <p className="complete__extranote">
            <strong>One-off extra.</strong> This visit sits outside{" "}
            {customerName}&rsquo;s{" "}
            {planFor(job.customer?.service_plan).label} plan — completing it
            won&rsquo;t change the plan or move their next visit.
          </p>
        )}

        {job.customer_id && !job.is_extra && (
          <>
            <label className="complete__label">
              Service plan{" "}
              <span className="complete__optional">
                (sets up their recurring visits)
              </span>
            </label>
            <PlanPicker
              propertyType={propertyType}
              plan={servicePlan}
              onPropertyTypeChange={setPropertyType}
              onPlanChange={setServicePlan}
              basePrice={finalPrice}
              currentPlan={job.customer?.service_plan}
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
          {/* Card and tap complete via their own buttons above — the job is
              only finished once the money actually clears. */}
          {method !== "card" && method !== "tap" && (
            <button
              className={`complete__submit ${
                method === "invoice" ? "complete__submit--invoice" : ""
              }`}
              onClick={handleComplete}
              disabled={saving}
            >
              {submitLabel()}
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
