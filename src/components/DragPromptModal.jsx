import { useState } from "react";
import PlanPicker from "./PlanPicker";
import "./AddLeadModal.css"; // reuse the same modal styling

/**
 * Shown when a lead is moved to a stage that needs information it hasn't got.
 *
 * `fields` is an array — 'price', 'appointment', or both — because a lead
 * dragged straight from Contacted to Booked is short of both at once. It
 * used to be a single field, and the effect was that such a move asked for
 * the appointment, never the price, and the lead landed on the board as
 * Booked at $0. That matters beyond tidiness: leads.estimate becomes
 * jobs.price at scheduling and is what the finder's and booking fees are
 * estimated from, so a $0 booking shows the rep nothing against work they
 * have actually closed.
 *
 * Calls onConfirm({ price, appointment }, extras) with only the fields it
 * asked for.
 */
export default function DragPromptModal({
  fields = [],
  stageLabel,
  lead,
  askPlan = false,
  onConfirm,
  onCancel,
}) {
  const needsPrice = fields.includes("price");
  const needsAppointment = fields.includes("appointment");

  const [price, setPrice] = useState("");
  const [appointment, setAppointment] = useState("");
  const [error, setError] = useState("");
  const [propertyType, setPropertyType] = useState(
    lead?.property_type || "residential"
  );
  const [servicePlan, setServicePlan] = useState(
    lead?.service_plan || "one_time"
  );

  function handleConfirm() {
    // Named individually rather than "fill in both fields": with two inputs
    // on screen, being told which one is still empty is the difference
    // between a one-second fix and re-reading the form.
    if (needsPrice && !(Number(price) > 0)) {
      setError("Enter a price to continue.");
      return;
    }
    if (needsAppointment && !appointment) {
      setError("Pick a time to continue.");
      return;
    }

    const values = {};
    if (needsPrice) values.price = price;
    if (needsAppointment) values.appointment = appointment;

    onConfirm(
      values,
      askPlan
        ? { property_type: propertyType, service_plan: servicePlan }
        : undefined
    );
  }

  return (
    <div className="modal" onClick={onCancel}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">
            Moving to <span className="modal__stage">{stageLabel}</span>
          </h2>
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__form">
          {/* Price first when both are asked: what you quoted is what you
              agreed before you agreed a time, and it's the field the rest
              of the form reacts to — the plan picker prices off it. */}
          {needsPrice && (
            <>
              <label className="modal__label">Quoted price ($)</label>
              <input
                className="modal__input"
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="300"
                min="0"
                autoFocus
              />
            </>
          )}

          {needsAppointment && (
            <>
              <label className="modal__label">Appointment</label>
              <input
                className="modal__input"
                type="datetime-local"
                value={appointment}
                onChange={(e) => setAppointment(e.target.value)}
                autoFocus={!needsPrice}
              />
            </>
          )}

          {askPlan && (
            <PlanPicker
              propertyType={propertyType}
              plan={servicePlan}
              onPropertyTypeChange={setPropertyType}
              onPlanChange={setServicePlan}
              // The price being typed above wins over whatever the lead
              // already had, so the discount preview tracks what you're
              // entering rather than a stale figure.
              basePrice={needsPrice ? price : lead?.estimate}
            />
          )}

          {error && <p className="modal__error">{error}</p>}

          <div className="modal__actions">
            <button className="modal__btn modal__btn--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="modal__btn modal__btn--primary" onClick={handleConfirm}>
              Confirm move
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
