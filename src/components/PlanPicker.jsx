import {
  PROPERTY_TYPES,
  SERVICE_PLANS,
  discountFor,
  planFor,
} from "../services/leadService";
import "./PlanPicker.css";

/**
 * Property type + recurring plan, shown together because the discount
 * depends on both — $50/$100 off for homes, $25/$50 for storefronts.
 *
 * The first cleaning is always the full quote. What's previewed here is
 * what every visit *after* the first will cost.
 */
export default function PlanPicker({
  propertyType,
  plan,
  onPropertyTypeChange,
  onPlanChange,
  basePrice,
  // The plan the customer is already on, when this picker sits on a job
  // screen. Job screens can only put someone onto a plan, never take them
  // off one, so say so rather than letting the control imply otherwise.
  currentPlan,
}) {
  const base = Number(basePrice) || 0;
  const onAPlan = currentPlan && currentPlan !== "one_time";
  const wouldDowngrade = onAPlan && plan === "one_time";

  return (
    <div className="planpick">
      <label className="planpick__label">Property type</label>
      <div className="planpick__types">
        {PROPERTY_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`planpick__type ${
              propertyType === t.key ? "planpick__type--active" : ""
            }`}
            onClick={() => onPropertyTypeChange(t.key)}
          >
            {t.label}
            <em className="planpick__typehint">{t.hint}</em>
          </button>
        ))}
      </div>

      <label className="planpick__label">Service plan</label>
      <div className="planpick__plans">
        {SERVICE_PLANS.map((p) => {
          const off = discountFor(p.key, propertyType);
          const active = plan === p.key;
          return (
            <button
              key={p.key}
              type="button"
              className={`planpick__plan ${active ? "planpick__plan--active" : ""}`}
              onClick={() => onPlanChange(p.key)}
            >
              <span className="planpick__planname">{p.label}</span>
              <span className="planpick__planwhen">
                {p.months ? `Every ${p.months} months` : "Single cleaning"}
              </span>
              <span
                className={`planpick__planoff ${
                  off ? "planpick__planoff--on" : ""
                }`}
              >
                {off ? `$${off} OFF` : "No discount"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Spell out the money, because "the first one is full price" is the
          part people get wrong when quoting at the door. */}
      {wouldDowngrade && (
        <p className="planpick__notice">
          This customer is on the {planFor(currentPlan).label} plan. Booking a
          one-time job won't cancel it — change the plan on their profile if
          that's what you want.
        </p>
      )}

      {plan !== "one_time" && base > 0 && (
        <p className="planpick__preview">
          First cleaning <strong>${base}</strong>, then{" "}
          <strong>${Math.max(0, base - discountFor(plan, propertyType))}</strong>{" "}
          every {planMonths(plan)} months.
        </p>
      )}
    </div>
  );
}

function planMonths(key) {
  return SERVICE_PLANS.find((p) => p.key === key)?.months ?? 0;
}
