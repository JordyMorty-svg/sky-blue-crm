import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchCustomer,
  applyPlanFromJob,
} from "../../services/customerService";
import { fetchTechs, scheduleJobForCustomer } from "../../services/jobService";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO } from "../../components/appointmentUtils";
import TechPicker from "../../components/TechPicker";
import PlanPicker from "../../components/PlanPicker";
import DayPreview from "../jobs/DayPreview";
import "../jobs/ScheduleJob.css";

/**
 * Book a job for an existing customer, with no lead in front of it — the
 * repeat-business path. Also where a one-off customer gets put onto a
 * recurring plan, since that decision usually happens at the second visit.
 */
export default function ScheduleForCustomer() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [techs, setTechs] = useState([]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  const [duration, setDuration] = useState(3);
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [price, setPrice] = useState("");
  const [services, setServices] = useState("Exterior windows");
  const [notes, setNotes] = useState("");
  const [propertyType, setPropertyType] = useState("residential");
  const [servicePlan, setServicePlan] = useState("one_time");
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [{ customer: c, jobs }, techData] = await Promise.all([
        fetchCustomer(id),
        fetchTechs(),
      ]);
      setCustomer(c);
      setTechs(techData);
      setPropertyType(c.property_type || "residential");
      setServicePlan(c.service_plan || "one_time");
      // Default to what they last paid, so repeat work is one tap.
      const lastPaid = jobs.find((j) => j.final_price ?? j.price);
      if (lastPaid) setPrice(String(lastPaid.final_price ?? lastPaid.price));
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!apptDate || !apptTime) {
      setError("Set a date and time.");
      return;
    }
    if (selectedTechs.length === 0) {
      setError("Assign at least one team member.");
      return;
    }
    if (!price || Number(price) <= 0) {
      setError("Enter a price for this visit.");
      return;
    }

    setSaving(true);
    try {
      // Only ever an upgrade — booking a one-off for a plan customer must
      // not cancel their plan.
      await applyPlanFromJob(id, { servicePlan, propertyType }, customer);

      await scheduleJobForCustomer({
        customer,
        startsAt: combineToISO(apptDate, apptTime),
        durationHours: Number(duration),
        techIds: selectedTechs,
        notes,
        price: Number(price),
        services,
        servicePlan,
        propertyType,
      });
      navigate(`/customers/${id}`);
    } catch (e) {
      console.error(e);
      setError("Couldn't schedule the job. Try again.");
      setSaving(false);
    }
  }

  if (loading) return <div className="scheduleJob__state">Loading…</div>;
  if (!customer)
    return <div className="scheduleJob__state">{error || "Not found."}</div>;

  return (
    <div className="scheduleJob">
      <button
        className="scheduleJob__back"
        onClick={() => navigate(`/customers/${id}`)}
      >
        ← Back to customer
      </button>

      <h1 className="scheduleJob__title">Schedule a job</h1>

      <div className="scheduleJob__lead">
        <strong>{customer.name}</strong>
        <span>{customer.address || "No address"}</span>
        <span>{customer.phone}</span>
      </div>

      {error && <p className="scheduleJob__error">{error}</p>}

      <form className="scheduleJob__form" onSubmit={handleSubmit}>
        <div className="scheduleJob__field">
          <AppointmentPicker
            date={apptDate}
            time={apptTime}
            onDateChange={setApptDate}
            onTimeChange={setApptTime}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Service</label>
          <select
            className="scheduleJob__input"
            value={services}
            onChange={(e) => setServices(e.target.value)}
          >
            <option value="Exterior windows">Exterior windows</option>
            <option value="Interior + exterior windows">
              Interior + exterior windows
            </option>
          </select>
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Price ($)</label>
          <input
            className="scheduleJob__input"
            type="number"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="300"
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Service plan</label>
          <PlanPicker
            propertyType={propertyType}
            plan={servicePlan}
            onPropertyTypeChange={setPropertyType}
            onPlanChange={setServicePlan}
            basePrice={price}
            currentPlan={customer.service_plan}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Estimated duration (hours)</label>
          <input
            className="scheduleJob__input"
            type="number"
            step="0.5"
            min="0.5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Assign team members</label>
          <TechPicker
            techs={techs}
            selectedIds={selectedTechs}
            onChange={setSelectedTechs}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Day preview &amp; conflicts</label>
          <DayPreview
            day={apptDate}
            time={apptTime}
            duration={Number(duration)}
            techIds={selectedTechs}
            onConflictChange={setConflicts}
          />
        </div>

        <div className="scheduleJob__field">
          <label className="scheduleJob__label">Notes</label>
          <textarea
            className="scheduleJob__input scheduleJob__textarea"
            rows="3"
            placeholder="Gate code, dog in yard, access instructions…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {conflicts.length > 0 && (
          <p className="scheduleJob__conflict">
            ⚠️ This overlaps an existing job for{" "}
            {[...new Set(conflicts.map((c) => c.techName))].join(", ")}. You can
            still schedule if that's intended.
          </p>
        )}

        <div className="scheduleJob__actions">
          <button
            type="button"
            className="scheduleJob__cancel"
            onClick={() => navigate(`/customers/${id}`)}
          >
            Cancel
          </button>
          <button type="submit" className="scheduleJob__submit" disabled={saving}>
            {saving ? "Scheduling…" : "Schedule job"}
          </button>
        </div>
      </form>
    </div>
  );
}
