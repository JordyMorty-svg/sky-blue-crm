import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  fetchCustomer,
  updateCustomer,
  deleteCustomer,
} from "../../services/customerService";
import {
  fetchNextVisit,
  ensureNextVisit,
  RECURRING_LEAD_TIME_DAYS,
} from "../../services/jobService";
import {
  PROPERTY_TYPES,
  SERVICE_PLANS,
  planFor,
  nextVisitDate,
  priceForVisit,
} from "../../services/leadService";
import AddressPicker from "../../components/AddressPicker";
import JobPlanTag from "../../components/JobPlanTag";
import RecordTabs from "../../components/RecordTabs";
import "./Customers.css";
import CustomerHeader from "../../components/CustomerHeader";
import CustomerProperties from "../../components/CustomerProperties";

function formatWhen(iso) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

const STATUS_LABELS = {
  scheduled: "Scheduled",
  upcoming: "Due",
  completed: "Completed",
  cancelled: "Cancelled",
};

function formatDue(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  /* Where "back" goes.
   *
   * The customer list is the default because that's where most links here
   * come from, but a job links here too, and landing on the customer list
   * from a job you were reading is a dead end — the job is gone and you
   * have to find it again.
   *
   * `fromState` is the state of the page that sent us, handed back when we
   * return to it. A job's own "back" is in its state, so carrying it means
   * Calendar -> job -> customer -> back -> job -> back lands on the
   * calendar, not on the jobs board. */
  const { state } = useLocation();
  const returnTo = state?.from || "/customers";
  const returnState = state?.fromState;
  const returnLabel = returnTo.startsWith("/jobs")
    ? "← Back to job"
    : returnTo.startsWith("/schedule")
      ? "← Back to schedule"
      : "← Back to customers";

  const [customer, setCustomer] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [leadNotes, setLeadNotes] = useState([]);
  // OPENS STRAIGHT INTO THE EDIT MODAL when Actions → Edit was pressed on
  // the Quotes or Communication tab. Those tabs have no modal of their own,
  // so they navigate here with `state.edit` rather than carrying a second
  // copy of the form — the same trick Actions → Send a quote already uses
  // with `state.send`. Without it, Edit from a sub-tab would dump you on
  // this page with nothing open and no sign anything had happened.
  const [editing, setEditing] = useState(Boolean(state?.edit));
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [nextVisit, setNextVisit] = useState(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [forceText, setForceText] = useState("");
  const [deleting, setDeleting] = useState(false);
  // quoteOpen lived here, because the button that opened the modal was in
  // the actions menu — a sibling of the panel rather than a child of it.
  // The panel is on its own page now and owns its own open state; the menu
  // item navigates there with { send: true } instead.

  async function load() {
    try {
      const { customer, jobs, leadNotes } = await fetchCustomer(id);
      setCustomer(customer);
      setForm(customer);
      setJobs(jobs ?? []);
      // Defaulted, not trusted. fetchCustomer builds this array itself and
      // always returns one — but `leadNotes.length` further down is read
      // unguarded, so the day anything hands back a null or an undefined
      // (a reshaped query, a cached response, a stub in a test) the whole
      // customer page renders as a blank white screen with one line in the
      // console. One `??` against a page that disappears is a good trade.
      setLeadNotes(leadNotes ?? []);
      setNextVisit(await fetchNextVisit(id));
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load this customer.");
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

  function set(field, value) {
    setForm((cur) => ({ ...cur, [field]: value }));
  }

  async function handleSave() {
    setError("");
    if (!form.name?.trim()) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    try {
      await updateCustomer(id, {
        name: form.name.trim(),
        phone: form.phone?.trim() || null,
        email: form.email?.trim() || null,
        address: form.address?.trim() || null,
        latitude: form.latitude ?? null,
        longitude: form.longitude ?? null,
        notes: form.notes?.trim() || null,
        property_type: form.property_type || "residential",
        service_plan: form.service_plan || "one_time",
      });
      setCustomer(form);
      setEditing(false);

      // Putting someone on a plan here is the "they liked it, sign them up"
      // path, and it usually happens after their first visit is already
      // finished. Nothing else would ever generate visit 2 in that case, so
      // do it now rather than leaving them with a plan and no due date.
      const planChanged =
        (form.service_plan || "one_time") !== (customer.service_plan || "one_time");
      if (planChanged && (form.service_plan || "one_time") !== "one_time") {
        try {
          await ensureNextVisit(id);
        } catch (visitErr) {
          console.error("Couldn't create the next visit:", visitErr);
        }
      }
      await load();
    } catch (e) {
      console.error(e);
      setError("Couldn't save changes. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setForm(customer);
    setEditing(false);
    setError("");
  }

  // Create the missing follow-up visit for a plan customer whose last job
  // is already finished. Surfaces the real error rather than logging it,
  // because a silent failure here is what hid the problem in the first
  // place.
  async function handleRepairVisit() {
    setRepairing(true);
    setRepairError("");
    try {
      const { created, reason } = await ensureNextVisit(id);
      if (!created) {
        setRepairError(
          reason === "no-completed-job"
            ? "There's no completed visit to count from yet."
            : "Nothing to create — they already have a visit on the books."
        );
      }
      await load();
    } catch (e) {
      console.error(e);
      setRepairError(e.message || "Couldn't create the next visit.");
    } finally {
      setRepairing(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      const { deleted, jobCount } = await deleteCustomer(id, {
        force: forceUnlocked,
      });
      if (!deleted) {
        setError(
          `This customer has ${jobCount} job${jobCount === 1 ? "" : "s"} on record. ` +
            "Tick the box below to delete those too."
        );
        setDeleting(false);
        return;
      }
      navigate("/customers");
    } catch (e) {
      console.error(e);
      setError("Couldn't delete this customer. Try again.");
      setDeleting(false);
    }
  }



  if (loading) return <div className="customers__state">Loading…</div>;
  if (!customer) return <div className="customers__state">{error || "Not found."}</div>;

  // Force is armed only when the box is ticked AND the word is typed.
  const forceUnlocked = forceDelete && forceText.trim() === "DELETE";
  const jobCount = jobs.length;

  const propertyType = customer.property_type || "residential";

  // Until the current job is finished there's no real due date — the clock
  // starts when the work actually happens. Project from the most recent
  // visit so a plan isn't invisible for three months. Display only: nothing
  // is written, and the real due date replaces it once one exists.
  //
  // `jobs` is ordered newest-first, so these pick the latest of each.
  const lastScheduled = jobs.find((j) => j.status === "scheduled");
  const lastCompleted = jobs.find((j) => j.status === "completed");
  // A booked job is the better anchor when there is one — it's the visit
  // the next one actually follows. Falling back to a completed job matters
  // for the case that used to show nothing at all: someone put on a plan
  // after their only visit was already finished.
  const anchorJob = lastScheduled || lastCompleted;
  // Same precedence createNextVisit uses, so what's shown matches what will
  // actually be created: the customer's plan is current truth, the job's
  // plan is the fallback for records booked before it was set.
  const effectivePlan =
    customer.service_plan && customer.service_plan !== "one_time"
      ? customer.service_plan
      : anchorJob?.service_plan || customer.service_plan || "one_time";
  const projectedVisit =
    !nextVisit && effectivePlan !== "one_time" && anchorJob?.starts_at
      ? {
          startsAt: nextVisitDate(anchorJob.starts_at, effectivePlan),
          price: priceForVisit(
            anchorJob.final_price ?? anchorJob.price,
            effectivePlan,
            (anchorJob.visit_number || 1) + 1,
            propertyType
          ),
          after: anchorJob.starts_at,
          fromCompleted: !lastScheduled,
        }
      : null;

  // Still needed here for the visit-repair check below, even though the
  // recurring BADGE moved into CustomerHeader with the rest of the top of
  // the page. Two different questions that happen to share a condition.
  const isRecurring =
    Boolean(customer.service_plan) && customer.service_plan !== "one_time";

  // A plan customer whose last visit is already finished should have a real
  // due date on record, not an estimate. If they don't, the row that should
  // have been created when that job completed never was — offer to create
  // it rather than quietly showing a projection forever.
  const needsVisitRepair =
    !nextVisit && !lastScheduled && isRecurring && !!lastCompleted;

  const completedJobs = jobs.filter((j) => j.status === "completed");

  const totalPaid = completedJobs.reduce(
    (sum, j) => sum + Number(j.final_price ?? j.price ?? 0),
    0
  );

  // suggestedQuoteFor() moved to customerService when quotes got their own
  // page: that page needs the same number, and two copies of the derivation
  // would be two answers to "what should we quote them" — the one nobody
  // updated being the one somebody sent. Nothing on THIS page needs it any
  // more, so it is called there and not here.

  // Work that hasn't happened yet — booked, or due on the plan. Kept out
  // of the visit count so it can't be read as work already done: a
  // recurring customer always has a future visit on record, and counting
  // it made a first-time customer look like a repeat one. It sits next to
  // the count as its own line instead.
  const pendingCount = jobs.filter(
    (j) => j.status === "scheduled" || j.status === "upcoming"
  ).length;

  return (
    <div className="custdetail">
      {/* The edit form is this same page with its fields opened up, not a
          page of its own — so while it's open, back means "put it away and
          give me the customer again". Leaving for the customer list from
          here is the one thing nobody wants: you came to change a phone
          number and you're thrown back to the top of the list. */}
      <button
        className="custdetail__back"
        onClick={() =>
          editing ? handleCancel() : navigate(returnTo, { state: returnState })
        }
      >
        {editing ? `← Back to ${customer.name}` : returnLabel}
      </button>

      {error && <p className="customers__error">{error}</p>}

      {editing ? (
        <div className="custedit">
          <label className="custedit__label">Name</label>
          <input
            className="custedit__input"
            value={form.name || ""}
            onChange={(e) => set("name", e.target.value)}
          />
          <label className="custedit__label">Phone</label>
          <input
            className="custedit__input"
            value={form.phone || ""}
            onChange={(e) => set("phone", e.target.value)}
          />
          <label className="custedit__label">Email</label>
          <input
            className="custedit__input"
            type="email"
            value={form.email || ""}
            onChange={(e) => set("email", e.target.value)}
          />
          <label className="custedit__label">Address</label>
          <AddressPicker
            value={form.address || ""}
            onChange={({ address, latitude, longitude }) => {
              setForm((cur) => ({ ...cur, address, latitude, longitude }));
            }}
            onTextChange={(text) => {
              setForm((cur) => ({
                ...cur,
                address: text,
                latitude: null,
                longitude: null,
              }));
            }}
            placeholder="123 Main St, Corvallis"
          />
          <label className="custedit__label">Property type</label>
          <select
            className="custedit__input"
            value={form.property_type || "residential"}
            onChange={(e) => set("property_type", e.target.value)}
          >
            {PROPERTY_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>

          <label className="custedit__label">Service plan</label>
          <select
            className="custedit__input"
            value={form.service_plan || "one_time"}
            onChange={(e) => set("service_plan", e.target.value)}
          >
            {SERVICE_PLANS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          <label className="custedit__label">Notes</label>
          <textarea
            className="custedit__input custedit__textarea"
            rows="4"
            placeholder="Prefers morning appointments, gate code, has a dog…"
            value={form.notes || ""}
            onChange={(e) => set("notes", e.target.value)}
          />
          <div className="custedit__actions">
            <button className="custedit__save" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="custedit__cancel" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <CustomerHeader customer={customer} onEdit={() => setEditing(true)} />

          {customer.notes && (
            <div className="custdetail__notes">
              <span className="custdetail__notes-label">Notes</span>
              <p className="custdetail__notes-text">{customer.notes}</p>
            </div>
          )}
        </>
      )}

      {leadNotes.length > 0 && (
        <div className="custdetail__leadnotes">
          <span className="custdetail__notes-label">From the original lead</span>
          {leadNotes.map((ln) => (
            <p key={ln.id} className="custdetail__notes-text">{ln.notes}</p>
          ))}
        </div>
      )}

      <div className="custdetail__stats">
        <div className="custdetail__stat">
          <span className="custdetail__stat-num">{completedJobs.length}</span>
          <span className="custdetail__stat-label">
            {completedJobs.length === 1 ? "Visit completed" : "Visits completed"}
          </span>
          {pendingCount > 0 && (
            <span className="custdetail__stat-extra">
              +{pendingCount} upcoming
            </span>
          )}
        </div>
        <div className="custdetail__stat">
          <span className="custdetail__stat-num">${totalPaid.toLocaleString()}</span>
          <span className="custdetail__stat-label">Lifetime value</span>
        </div>
      </div>

      {projectedVisit?.startsAt && (
        <div className="custdetail__nextvisit custdetail__nextvisit--estimate">
          <span className="custdetail__nextvisit-label">
            Next visit expected
          </span>
          <strong className="custdetail__nextvisit-date">
            around {formatDue(projectedVisit.startsAt)}
          </strong>
          <span className="custdetail__nextvisit-note">
            {projectedVisit.fromCompleted ? (
              <>
                Estimated at ${projectedVisit.price}, counting{" "}
                {planFor(effectivePlan).months} months from their last visit
                on {formatDue(projectedVisit.after)}.
              </>
            ) : (
              <>
                Estimated at ${projectedVisit.price}, counting{" "}
                {planFor(effectivePlan).months} months from the job booked for{" "}
                {formatDue(projectedVisit.after)}. The real due date is set
                when that job is marked complete.
              </>
            )}
          </span>

          {needsVisitRepair && (
            <div className="custdetail__repair">
              <span className="custdetail__repair-text">
                This visit isn't on the books yet — it's only an estimate, so
                it won't reach the Jobs board. That happens when someone is
                put on a plan after their last visit was already finished.
              </span>
              <button
                className="custdetail__repair-btn"
                onClick={handleRepairVisit}
                disabled={repairing}
              >
                {repairing ? "Creating…" : "Put it on the books"}
              </button>
              {repairError && (
                <span className="custdetail__repair-error">{repairError}</span>
              )}
            </div>
          )}
        </div>
      )}

      {nextVisit && (
        <div className="custdetail__nextvisit">
          <span className="custdetail__nextvisit-label">Next visit due</span>
          <strong className="custdetail__nextvisit-date">
            {formatDue(nextVisit.starts_at)}
          </strong>
          <span className="custdetail__nextvisit-note">
            ${nextVisit.price} · not scheduled yet — it moves onto the Jobs
            board {RECURRING_LEAD_TIME_DAYS} days beforehand so a crew can be
            assigned.
          </span>
        </div>
      )}

      {/* The two doors off this customer.

          Quotes and the whole text conversation used to be panels here,
          stacked between the stat tiles and the job history — which is the
          thing most people open a customer to look at, and it sat below
          both of them. See RecordTabs.jsx.

          NO beforeLeave, unlike the lead page. That one is a form with
          unsaved edits in it; this page edits through a modal that saves
          itself, so there is nothing to lose by navigating away. */}
      <RecordTabs base={`/customers/${id}`} active="info" infoLabel="Customer info" />

      {/* Where this customer's buildings are managed. On the info tab only:
          the quote modal and the booking screen pick between them, and this
          is where they get named, re-defaulted and retired. */}
      <CustomerProperties customerId={id} />

      <h2 className="custdetail__subhead">Job history</h2>
      {jobs.length === 0 ? (
        <p className="customers__empty">No jobs yet.</p>
      ) : (
        <>
          {jobs.some((j) => j.status === "scheduled") && (
            <div className="custdetail__scheduled">
              <span className="custdetail__scheduled-label">Upcoming — scheduled, not yet complete</span>
              {jobs
                .filter((j) => j.status === "scheduled")
                .map((job) => (
                  <div
                    className="custjob custjob--upcoming custjob--clickable"
                    key={job.id}
                    onClick={() =>
                      // Hand the editor a return path so Save/Cancel come
                      // back here rather than dumping you on the Jobs board.
                      navigate(`/jobs/${job.id}`, {
                        state: { from: `/customers/${id}` },
                      })
                    }
                    role="button"
                    tabIndex={0}
                  >
                    <div className="custjob__main">
                      <span className="custjob__when">{formatWhen(job.starts_at)}</span>
                      <span className="custjob__meta">
                        {job.services} · {job.duration_hours}h
                      </span>
                      <JobPlanTag job={job} />
                      <span className="custjob__crew">
                        {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                      </span>
                    </div>
                    <div className="custjob__right">
                      <span className="custjob__price">
                        ${(job.final_price ?? job.price ?? 0).toLocaleString()}
                      </span>
                      <span className="custjob__status custjob__status--scheduled">
                        Scheduled
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="customers__list">
            {jobs
              .filter((j) => j.status !== "scheduled" && j.status !== "upcoming")
              .map((job) => (
                <div
                  className={
                    "custjob custjob--clickable" +
                    (job.status === "cancelled" ? " custjob--cancelled" : "")
                  }
                  key={job.id}
                  // A completed job opens its read-only record: there's a
                  // payment behind it that editing would silently contradict.
                  //
                  // A cancelled one opens the editor instead. It isn't a
                  // record of work done, and the editor is where its history
                  // and the "put it back" button live.
                  onClick={() =>
                    navigate(
                      job.status === "completed"
                        ? `/jobs/record/${job.id}`
                        : `/jobs/${job.id}`,
                      { state: { from: `/customers/${id}` } }
                    )
                  }
                  role="button"
                  tabIndex={0}
                >
                  <div className="custjob__main">
                    <span className="custjob__when">{formatWhen(job.starts_at)}</span>
                    <span className="custjob__meta">
                      {job.services} · {job.duration_hours}h
                    </span>
                    <JobPlanTag job={job} />
                    <span className="custjob__crew">
                      {job.assignments?.map((a) => a.tech?.full_name).filter(Boolean).join(", ")}
                    </span>
                  </div>
                  <div className="custjob__right">
                    <span className="custjob__price">
                      ${(job.final_price ?? job.price ?? 0).toLocaleString()}
                    </span>
                    <span className={`custjob__status custjob__status--${job.status}`}>
                      {STATUS_LABELS[job.status] || job.status}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      <div className="custdetail__danger">
        {confirmDelete ? (
          <>
            <p className="custdetail__dangertext">
              Delete <strong>{customer.name}</strong> permanently?
              {jobCount > 0
                ? ` They have ${jobCount} job${jobCount === 1 ? "" : "s"} on record — deleting removes that revenue history from your Income totals.`
                : " They have no jobs on record."}
            </p>

            {jobCount > 0 && (
              <label className="custdetail__forcecheck">
                <input
                  type="checkbox"
                  checked={forceDelete}
                  onChange={(e) => {
                    setForceDelete(e.target.checked);
                    if (!e.target.checked) setForceText("");
                  }}
                  disabled={deleting}
                />
                <span>
                  Delete their {jobCount} job{jobCount === 1 ? "" : "s"} too
                  <em className="custdetail__forcehint">
                    For clearing test data. Payments already taken stay in
                    Square — this only removes the CRM's record.
                  </em>
                </span>
              </label>
            )}

            {jobCount > 0 && forceDelete && (
              <>
                <label className="custdetail__forcelabel">
                  Type <strong>DELETE</strong> to confirm
                </label>
                <input
                  className="custdetail__forceinput"
                  type="text"
                  value={forceText}
                  onChange={(e) => setForceText(e.target.value)}
                  placeholder="DELETE"
                  autoComplete="off"
                  disabled={deleting}
                />
              </>
            )}

            <div className="custdetail__dangeractions">
              <button
                className="custdetail__deleteyes"
                onClick={handleDelete}
                disabled={
                  deleting || (jobCount > 0 && (!forceDelete || !forceUnlocked))
                }
              >
                {deleting
                  ? "Deleting…"
                  : jobCount > 0 && forceDelete && !forceUnlocked
                    ? "Type DELETE to confirm"
                    : "Yes, delete"}
              </button>
              <button
                className="custedit__cancel"
                onClick={() => {
                  setConfirmDelete(false);
                  setForceDelete(false);
                  setForceText("");
                  setError("");
                }}
                disabled={deleting}
              >
                Keep it
              </button>
            </div>
          </>
        ) : (
          <button
            className="custdetail__delete"
            onClick={() => setConfirmDelete(true)}
          >
            Delete customer
          </button>
        )}
      </div>
    </div>
  );
}