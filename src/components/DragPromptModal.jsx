import { useState } from "react";
import PlanPicker from "./PlanPicker";
import "./AddLeadModal.css"; // reuse the same modal styling

// Shown when a lead is dragged to a stage that needs info it doesn't have.
// `field` is 'price' or 'appointment'. Calls onConfirm(value) or onCancel().
export default function DragPromptModal({
  field,
  stageLabel,
  lead,
  askPlan = false,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [propertyType, setPropertyType] = useState(
    lead?.property_type || "residential"
  );
  const [servicePlan, setServicePlan] = useState(
    lead?.service_plan || "one_time"
  );

  const isPrice = field === "price";

  function handleConfirm() {
    if (!value) {
      setError(isPrice ? "Enter a price to continue." : "Pick a time to continue.");
      return;
    }
    onConfirm(
      value,
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
          {isPrice ? (
            <>
              <label className="modal__label">Quoted price ($)</label>
              <input
                className="modal__input"
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="300"
                min="0"
                autoFocus
              />
            </>
          ) : (
            <>
              <label className="modal__label">Appointment</label>
              <input
                className="modal__input"
                type="datetime-local"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            </>
          )}

          {askPlan && (
            <PlanPicker
              propertyType={propertyType}
              plan={servicePlan}
              onPropertyTypeChange={setPropertyType}
              onPlanChange={setServicePlan}
              basePrice={isPrice ? value : lead?.estimate}
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