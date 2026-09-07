import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  fetchJob,
  updateJob,
  updateJobTechs,
  fetchTechs,
  deleteJob,
  setJobPlan,
  cancelJob,
  restoreJob,
} from "../../services/jobService";
import { applyPlanFromJob } from "../../services/customerService";
import PlanPicker from "../../components/PlanPicker";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import TechPicker from "../../components/TechPicker";
import ServicePicker from "../../components/ServicePicker";
import JobHistory from "../../components/JobHistory";
import "./JobDetail.css";

export default function JobDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Where to return to. Set by whoever linked here; the Jobs board is the
  // default because that's where most job links come from.
  const { state } = useLocation();
  const returnTo = state?.from || "/jobs";
  const returnLabel = returnTo.startsWith("/customers")
    ? "← Back to customer"
    : returnTo.startsWith("/schedule")
      ? "← Back to schedule"
      : "← Back to jobs";

  const [job, setJob] = useState(null);
  const [techs, setTechs] = useState([]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  const [originalTechs, setOriginalTechs] = useState([]);
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState("");
  const [duration, setDuration] = useState(3);
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [serviceKeys, setServiceKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [propertyType, setPropertyType] = useState("residential");
  const [servicePlan, setServicePlan] = useState("one_time");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function load() {
    try {
      const [jobData, techData] = await Promise.all([fetchJob(id), fetchTechs()]);
      setJob(jobData);
      setTechs(techData);

      const assigned = (jobData.assignments || []).map((a) => a.tech_id);
      setSelectedTechs(assigned);
      setOriginalTechs(assigned);

      const { date, time } = splitFromISO(jobData.starts_at);
      setApptDate(date);
      setApptTime(time);
      setDuration(jobData.duration_hours ?? 3);
      setPrice(jobData.price ?? "");
      setNotes(jobData.notes ?? "");
      // Empty for a job created before db/job-services.sql. The picker shows
      // nothing selected, which is honest — and the moment anyone picks
      // something, that job stops describing itself as window cleaning by
      // default.
      setServiceKeys(jobData.service_keys ?? []);
      // Plan comes from the customer, which is what drives recurrence.
      setPropertyType(
        jobData.customer?.property_type || jobData.property_type || "residential"
      );
      setServicePlan(
        jobData.customer?.service_plan || jobData.service_plan || "one_time"
      );
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this job.");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Declared above the handlers that close over it, for the same reason as
  // extraBooking in ScheduleForCustomer: the early returns below would
  // otherwise leave it in the temporal dead zone on renders that bail out.
  const isCancelled = job?.status === "cancelled";

  async function handleSave() {
    setError("");
    if (!apptDate || !apptTime) {
      setError("Set an appointment date and time.");
      return;
    }
    if (selectedTechs.length === 0) {
      setError("Assign at least one team member.");
      return;
    }

    setSaving(true);
    try {
      await updateJob(id, {
        starts_at: combineToISO(apptDate, apptTime),
        duration_hours: Number(duration),
        price: Number(price) || 0,
        notes: notes || null,
        // The jobs_sync_services trigger rewrites `services` from this, and
        // jobs_log_services puts the change on the job's history — so adding
        // gutters on the day is recorded rather than silently overwriting
        // what the job used to say it was.
        service_keys: serviceKeys,
      });
      await updateJobTechs(id, originalTechs, selectedTechs);

      // Putting someone onto a plan mid-job is the common case. Upgrades
      // only — see applyPlanFromJob.
      await applyPlanFromJob(
        job.customer_id,
        { servicePlan, propertyType },
        job.customer
      );
      // Stamp the job too, so it counts as the first plan visit and the
      // next one is generated from it.
      await setJobPlan(id, { servicePlan, propertyType });

      navigate(returnTo);
    } catch (e) {
      console.error(e);
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setError("");
    try {
      await cancelJob(id);
      navigate(returnTo);
    } catch (e) {
      console.error(e);
      setError("Couldn't cancel this job. Try again.");
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  async function handleRestore() {
    setCancelling(true);
    setError("");
    try {
      await restoreJob(id);
      await load();
    } catch (e) {
      console.error(e);
      setError("Couldn't restore this job. Try again.");
    } finally {
      setCancelling(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await deleteJob(id);
      navigate(returnTo);
    } catch (e) {
      console.error(e);
      setError("Couldn't delete this job. Try again.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) return <div className="jobDetail__state">Loading…</div>;
  if (!job) return <div className="jobDetail__state">{error || "Not found."}</div>;

  return (
    <div className="jobDetail">
      <button className="jobDetail__back" onClick={() => navigate(returnTo)}>
        {returnLabel}
      </button>

      <h1 className="jobDetail__title">
        {job.lead?.name || job.customer?.name || "Job"}
      </h1>

      <div className="jobDetail__lead">
        <span>{job.lead?.address || job.customer?.address || "No address"}</span>
        <span>{job.lead?.phone || job.customer?.phone}</span>
        <span>{job.services}</span>
      </div>

      {error && <p className="jobDetail__error">{error}</p>}

      {/* A cancelled job stays fully readable and editable — it's a record,
          not an archive. The banner is here so nobody assigns crew to it by
          accident, and so the way back is obvious. */}
      {isCancelled && (
        <div className="jobDetail__cancelled">
          <div className="jobDetail__cancelledtext">
            <strong>This job was cancelled.</strong> It stays on{" "}
            {job.customer?.name || job.lead?.name || "the customer"}&rsquo;s
            profile as a record. It isn&rsquo;t on the schedule and doesn&rsquo;t
            count towards their visits or lifetime value.
          </div>
          <button
            type="button"
            className="jobDetail__restore"
            onClick={handleRestore}
            disabled={cancelling}
          >
            {cancelling ? "Restoring…" : "Put it back"}
          </button>
        </div>
      )}

      <div className="jobDetail__form">
        <AppointmentPicker
          date={apptDate}
          time={apptTime}
          onDateChange={setApptDate}
          onTimeChange={setApptTime}
        />

        <label className="jobDetail__label">Estimated duration (hours)</label>
        <input
          className="jobDetail__input"
          type="number"
          step="0.5"
          min="0.5"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />

        <label className="jobDetail__label">Price ($)</label>
        <input
          className="jobDetail__input"
          type="number"
          min="0"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />

        {/* Editable while the job is still ahead of you: "they asked us to
            do the gutters too" is a normal thing to hear on the doorstep,
            and it changes the price and the time. */}
        <div className="jobDetail__services">
          <ServicePicker value={serviceKeys} onChange={setServiceKeys} />
        </div>

        <label className="jobDetail__label">Assigned team members</label>
        <TechPicker
          techs={techs}
          selectedIds={selectedTechs}
          onChange={setSelectedTechs}
        />

        {job.customer_id && (
          <>
            <label className="jobDetail__label">Service plan</label>
            <PlanPicker
              propertyType={propertyType}
              plan={servicePlan}
              onPropertyTypeChange={setPropertyType}
              onPlanChange={setServicePlan}
              basePrice={price}
              currentPlan={job.customer?.service_plan}
            />
          </>
        )}

        <label className="jobDetail__label">Notes</label>
        <textarea
          className="jobDetail__input jobDetail__textarea"
          rows="3"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Gate code, dog in yard, access instructions…"
        />

        <div className="jobDetail__actions">
          <button className="jobDetail__save" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button className="jobDetail__cancel" onClick={() => navigate(returnTo)}>
            Cancel
          </button>
        </div>

        {/* Cancelling comes first and reads as the ordinary thing to do,
            because it almost always is: the customer called off the job and
            that fact is worth keeping. Delete is the rare one — it destroys
            the row and its history with it — so it sits below, quieter. */}
        {!isCancelled && (
          <div className="jobDetail__danger">
            {confirmCancel ? (
              <>
                <span className="jobDetail__dangertext">
                  Cancel this job? It stays on the customer&rsquo;s profile as
                  a record and comes off the schedule.
                </span>
                <button
                  className="jobDetail__cancelyes"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelling…" : "Yes, cancel it"}
                </button>
                <button
                  className="jobDetail__cancel"
                  onClick={() => setConfirmCancel(false)}
                  disabled={cancelling}
                >
                  Keep it booked
                </button>
              </>
            ) : (
              <button
                className="jobDetail__canceljob"
                onClick={() => setConfirmCancel(true)}
              >
                Cancel this job
              </button>
            )}
          </div>
        )}

        <div className="jobDetail__danger">
          {confirmDelete ? (
            <>
              <span className="jobDetail__dangertext">
                Delete this job permanently? Its history goes too, and any
                payment recorded against it. Cancel it instead if you want to
                keep the record.
              </span>
              <button
                className="jobDetail__deleteyes"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Yes, delete"}
              </button>
              <button
                className="jobDetail__cancel"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              className="jobDetail__delete"
              onClick={() => setConfirmDelete(true)}
            >
              Delete job
            </button>
          )}
        </div>
      </div>

      {/* The same history the finished-job record shows. Useful before the
          job as well as after it: "have we already moved this twice?" and
          "when did they go onto the plan?" are questions you ask while the
          job is still upcoming, and the answer is right here rather than in
          somebody's memory of a text message.

          A scheduled job simply has no completion or payment row yet — the
          component needs no special case for it, because those events are
          only written when the work is actually submitted. */}
      <JobHistory jobId={id} className="jobDetail__history" />
    </div>
  );
}