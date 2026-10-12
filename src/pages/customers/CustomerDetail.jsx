import { useEffect, useState } from "react";
import { useOutletContext, useParams, useNavigate, useLocation } from "react-router-dom";
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
import JobPlanTag from "../../components/JobPlanTag";
import "./Customers.css";
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
  // returnTo / returnLabel moved into CustomerHeader, which draws the back
  // link on all three tabs. `state` is still read here for state.edit — see
  // the useState below.

  // THE RECORD COMES FROM THE LAYOUT. CustomerLayout fetches it once and
  // stays mounted across the three tabs; this page used to fetch it again
  // on arrival, which is why the header blinked on every tab press.
  const { customer, jobs, reload, setChrome, openEditRef, cancelEditRef } =
    useOutletContext();
  const [leadNotes, setLeadNotes] = useState([]);
  // OPENS STRAIGHT INTO THE EDIT MODAL when Actions → Edit was pressed on
  // the Quotes or Communication tab. Those tabs have no modal of their own,
  // so they navigate here with `state.edit` rather than carrying a second
  // copy of the form — the same trick Actions → Send a quote already uses
  // with `state.send`. Without it, Edit from a sub-tab would dump you on
  // this page with nothing open and no sign anything had happened.
  const [editing, setEditing] = useState(Boolean(state?.edit));
  /* THE EDIT FORM'S DRAFT, derived rather than seeded.
   *
   * This was `useState(null)` filled in by the page's own load(). When the
   * record moved up to CustomerLayout that load() stopped fetching the
   * customer — and stopped seeding this — so opening the edit form read
   * `form.name` off null and the whole page rendered blank. A form whose
   * starting values live in two places (a fetch that fills it, and a null
   * that means "not filled yet") has a third state nobody tested.
   *
   * Null now means "no edits yet", and `draft` below falls back to the
   * customer. Cancelling and saving both just clear it.
   */
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

  // WHAT THIS PAGE STILL FETCHES FOR ITSELF. The customer and their jobs
  // belong to CustomerLayout; the original lead's notes and the projected
  // next visit are only ever read here, so fetching them in the layout
  // would make the Quotes and Communication tabs pay for them.
  async function load() {
    try {
      const { leadNotes: notes } = await fetchCustomer(id);
      setLeadNotes(notes ?? []);
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
    setForm((cur) => ({ ...(cur ?? customer), [field]: value }));
  }

  /* DECLARED ABOVE THE HANDLERS THAT CLOSE OVER IT, not beside the JSX.
     Same reasoning as extraBooking in ScheduleForCustomer: a const
     declared after the early returns is in the temporal dead zone on any
     render that bails out, and the only thing keeping that harmless is
     that those renders never call the handler. */
  const draft = form ?? customer ?? {};

  async function handleSave() {
    setError("");
    if (!draft.name?.trim()) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    try {
      await updateCustomer(id, {
        name: draft.name.trim(),
        phone: draft.phone?.trim() || null,
        email: draft.email?.trim() || null,
        address: draft.address?.trim() || null,
        latitude: draft.latitude ?? null,
        longitude: draft.longitude ?? null,
        notes: draft.notes?.trim() || null,
        property_type: draft.property_type || "residential",
        service_plan: draft.service_plan || "one_time",
      });
      setEditing(false);
      setForm(null);
      // The layout owns the record, so it is the one that has to re-read
      // it — setting a local copy would leave the header showing the old
      // name until something else forced a fetch.
      await reload();

      // Putting someone on a plan here is the "they liked it, sign them up"
      // path, and it usually happens after their first visit is already
      // finished. Nothing else would ever generate visit 2 in that case, so
      // do it now rather than leaving them with a plan and no due date.
      const planChanged =
        (draft.service_plan || "one_time") !== (customer.service_plan || "one_time");
      if (planChanged && (draft.service_plan || "one_time") !== "one_time") {
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
    // Null, not a copy of the customer: the draft derives from the record,
    // so clearing it IS discarding the edits.
    setForm(null);
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



  /* WHAT THE LAYOUT NEEDS TO KNOW ABOUT THIS TAB.
   *
   * Refs for the callbacks, written on every render with no dependency
   * array: always current, and writing to a ref never re-renders the
   * layout. A callback in the layout's state would re-render the whole
   * record on every keystroke in this draft.
   *
   * State for the two things that change what the layout DRAWS — whether
   * the tabs show, and what the back link says. Primitives, keyed on the
   * boolean, so it fires when the mode flips and not otherwise. An object
   * of functions here is how a layout like this turns into a render loop.
   */
  useEffect(() => {
    openEditRef.current = () => setEditing(true);
    cancelEditRef.current = handleCancel;
    return () => {
      openEditRef.current = null;
      cancelEditRef.current = null;
    };
  });

  useEffect(() => {
    setChrome({
      hideTabs: editing,
      backLabel: editing ? `← Back to ${customer?.name ?? "customer"}` : null,
    });
  }, [editing, customer?.name, setChrome]);

  if (loading) return <div className="customers__state">Loading…</div>;
  // CustomerLayout does not render this tab unless it has the customer, so
  // this is belt and braces rather than a path anybody reaches.
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
    <>
      {error && <p className="customers__error">{error}</p>}

      {editing ? (
        <div className="custedit">
          <label className="custedit__label">Name</label>
          <input
            className="custedit__input"
            value={draft.name || ""}
            onChange={(e) => set("name", e.target.value)}
          />
          <label className="custedit__label">Phone</label>
          <input
            className="custedit__input"
            value={draft.phone || ""}
            onChange={(e) => set("phone", e.target.value)}
          />
          <label className="custedit__label">Email</label>
          <input
            className="custedit__input"
            type="email"
            value={draft.email || ""}
            onChange={(e) => set("email", e.target.value)}
          />
          {/* THE ADDRESS FIELD IS GONE FROM THIS FORM, deliberately.
              Addresses live in customer_properties now, and the default one
              is mirrored onto customers.address by a trigger — see
              db/property-default-sync.sql. Leaving an address box here
              would let somebody type a new address straight onto the
              customer row, where it would disagree with the default
              property until the next time anyone touched that property, at
              which point their typing would silently vanish.

              One place to edit an address: the Addresses panel below. */}
          <p className="custedit__note">
            Addresses are managed under <strong>Addresses</strong> on the
            Customer info tab.
          </p>
          <label className="custedit__label">Property type</label>
          <select
            className="custedit__input"
            value={draft.property_type || "residential"}
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
            value={draft.service_plan || "one_time"}
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
            value={draft.notes || ""}
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

          {customer.notes && (
            <div className="custdetail__notes">
              <span className="custdetail__notes-label">Notes</span>
              <p className="custdetail__notes-text">{customer.notes}</p>
            </div>
          )}
        </>
      )}

      {/* NOT WHILE THE EDIT FORM IS OPEN.

          The stat tiles, the addresses and the whole job history used to
          carry on below the form — so editing a phone number put a form at
          the top of a page that still had five screens of the thing you
          were editing underneath it, and the Save button a long way from
          the bottom.

          The TABS are hidden by CustomerLayout rather than here, because
          they belong to the layout now; this page tells it to via
          setChrome. An edit form is a mode, and while you are in it the
          record it belongs to is the draft. */}
      {!editing && (
        <>
  
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



        {/* Where this customer's buildings are managed. On the info tab only:
            the quote modal and the booking screen pick between them, and this
            is where they get named, re-defaulted and retired.

            Directly above the job history, so the page reads where → what we
            did there, rather than putting a block of admin between the tabs
            and the numbers most people open a customer to see. */}
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
        </>
      )}

    </>
  );
}