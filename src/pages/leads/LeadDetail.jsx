import { useEffect, useState } from "react";
import { useOutletContext, useParams, useNavigate } from "react-router-dom";
import AddressPicker from "../../components/AddressPicker";
import {
  ALL_STATUSES,
  deleteLead,
  fetchAssignableOwners,
  fetchLeadEvents,
  LEAD_SOURCES,
  LEADS_SETTABLE_STATUSES,
  reassignLead,
  saveProblem,
  SERVICE_TYPES,
  serviceFor,
  TEMPERATURES,
  updateLead,
} from "../../services/leadService";
import { useAuth } from "../../context/useAuth";
import { can } from "../../components/capabilities";
import PlanPicker from "../../components/PlanPicker";
import AppointmentPicker from "../../components/AppointmentPicker";
import { combineToISO, splitFromISO } from "../../components/appointmentUtils";
import "./LeadDetail.css";

export default function LeadDetail() {
  const { id } = useParams();
  // THE LEAD COMES FROM THE LAYOUT — see LeadLayout.jsx. This page is the
  // form over it, so `form` below is the draft: null until something is
  // typed, falling back to the record.
  const { lead, reload, beforeLeaveRef } = useOutletContext();
  const navigate = useNavigate();

  /* THE DRAFT, derived rather than seeded — same shape as CustomerDetail.
     Null means "nothing typed yet"; `draft` below falls back to the
     record. Seeding it from a fetch is what left the customer page blank
     when that fetch moved up to the layout. */
  const [form, setForm] = useState(null);
  /* THE APPOINTMENT, as two draft strings over one stored timestamp.
     Null means "untouched", and the pair below falls back to whatever the
     record says — the same trick as `form`, and for the same reason: an
     effect that seeds state from a prop is a second source of truth and a
     render loop waiting to be written. */
  const [apptDate, setApptDate] = useState(null);
  const [apptTime, setApptTime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { role, user } = useAuth();
  const canDelete = can(role, "delete_leads");
  const [events, setEvents] = useState([]);
  // Shut to begin with. See the note above the panel.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [owners, setOwners] = useState([]);
  const [reassigning, setReassigning] = useState(false);
  const [reassignNote, setReassignNote] = useState("");

  // Calls are filtered out here rather than in the list, so the count on the
  // button and the rows behind it can never disagree. They were separate
  // once and the button offered to show four rows and then showed two:
  // contact_log owns outreach now, and db/contact-history.sql copied the old
  // 'call' lead_events across, so leaving them in would show every historic
  // call twice.
  const visibleEvents = events.filter((ev) => (ev.kind || "status") !== "call");

  // WHAT THIS PAGE STILL FETCHES. The lead belongs to LeadLayout; the
  // status history is only ever read here, so fetching it up there would
  // make the Quotes and Communication tabs pay for it.
  async function load() {
    try {
      setEvents(await fetchLeadEvents(id));
    } catch (histErr) {
      // Nice-to-have. A failure here must not stop the page rendering the
      // lead itself.
      console.error("Couldn't load status history:", histErr);
      setEvents([]);
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

  // The tab strip lives in LeadLayout now, but this page is a form and
  // leaving it does not save it. The layout calls through this ref before
  // it navigates — see the note at the top of LeadLayout.jsx. Written on
  // every render so it never goes stale, and cleared on unmount so the
  // other two tabs navigate straight away.
  useEffect(() => {
    beforeLeaveRef.current = persist;
    return () => {
      beforeLeaveRef.current = null;
    };
  });

  // Only an owner can reattribute a lead, so only an owner needs the list of
  // people to attribute it to.
  useEffect(() => {
    if (!can(role, "reassign_leads")) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchAssignableOwners();
        if (!cancelled) setOwners(list);
      } catch (e) {
        console.error("Couldn't load the rep list:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [role]);

  async function handleReassign(newOwnerId) {
    setReassigning(true);
    setReassignNote("");
    setError("");
    try {
      // The database decides what happened to the money and says so; this
      // just relays it. Then reload, because the fee may have been created,
      // deleted, or re-rated and the page shouldn't be guessing.
      const note = await reassignLead(id, newOwnerId || null);
      setReassignNote(note);
      await load();
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't reassign that lead.");
    } finally {
      setReassigning(false);
    }
  }

  function set(field, value) {
    setForm((f) => ({ ...(f ?? lead), [field]: value }));
  }

  /**
   * Write the form to the lead. No navigation, no state juggling.
   *
   * Split out of handleSave() so that "Save changes" and "save before
   * sending a quote" cannot drift apart. That matters more here than it
   * looks: the payload below is an EXPLICIT COLUMN LIST, not a spread of
   * `form`, so a second copy of it would quietly stop saving whichever
   * field was added last — exactly the failure the comments inside it warn
   * about, one level up.
   *
   * Throws on failure. The callers decide what that means.
   */
  const draft = form ?? lead ?? {};
  const storedAppt = splitFromISO(lead?.appointment_at);
  const apptDateValue = apptDate ?? storedAppt.date;
  const apptTimeValue = apptTime ?? storedAppt.time;

  async function persist() {
    await updateLead(id, {
        name: draft.name,
        phone: draft.phone || null,
        email: draft.email || null,
        address: draft.address || null,
        // Named explicitly, like everything else here — see the comment
        // below. Without these two the picker would appear to work and the
        // pin would revert on reload.
        latitude: draft.latitude ?? null,
        longitude: draft.longitude ?? null,
        stories: draft.stories,
        windows: Number(draft.windows) || 1,
        interior: draft.interior,
        estimate: Number(draft.estimate) || 0,
        status: draft.status,
        temperature: draft.temperature || null,
        // The save payload is an explicit column list, not a spread of
        // `form` — so a new editable field is invisible until it's named
        // here. The picker would have looked like it worked and quietly
        // reverted on reload.
        source: draft.source || "door",
        // No `|| DEFAULT_SERVICE` here on purpose — see the picker below.
        // Null means nobody recorded it, which is a fact worth keeping.
        service: draft.service || null,
        property_type: draft.property_type || "residential",
        service_plan: draft.service_plan || "one_time",
        appointment_at: combineToISO(apptDateValue, apptTimeValue),
        notes: draft.notes || null,
        crm_notes: draft.crm_notes || null,
    });

    // The layout holds the record and the tab strip reads from it, so it
    // has to re-read after a save — and the draft clears, because the
    // record it falls back to is now the thing that was just saved.
    // Without this, saving and then pressing a tab would show the old name
    // in the header beside the new one in the form.
    await reload();
    setForm(null);
    setApptDate(null);
    setApptTime(null);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await persist();
      navigate("/leads");
    } catch (e) {
      console.error(e);
      // The database's own reason, not a shrug. "Try again" was wrong advice
      // for the bug that prompted this: a CHECK constraint on leads.status
      // that predated the Lost status, where trying again fails identically
      // every time and the only explanation was in a console nobody on a
      // phone can open.
      setError(saveProblem(e, "save"));
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteLead(id);
      navigate("/leads");
    } catch (e) {
      console.error(e);
      setError(saveProblem(e, "delete"));
    }
  }

  // NO PAGE-LEVEL LOADING GATE. The lead is the layout's and is already
  // here; `loading` now covers only the status history further down, and
  // holding the whole form back for it is the flash this refactor was
  // meant to remove.
  // NOT `if (!form)`, which is what this said and why every lead rendered
  // "Not found." the moment the record moved up to LeadLayout: `form` is
  // the DRAFT now, and it is null until somebody types something. The
  // layout does not render this tab at all unless it has the lead, so the
  // only thing left worth guarding is a lead id that resolved to nothing.
  if (!lead) return <div className="detail__state">{error || "Not found."}</div>;

  // Who may close a lead out.
  //
  // Lost and Archived are the two transitions that can release a
  // commission: a lead 30+ quiet days old gives up its pending fees when it
  // is killed, and on a shared board that fee may belong to someone else.
  // Owners may close anything. Everyone else may close their own — which is
  // the case that actually matters in the field, because the lead you just
  // knocked and got a no on is yours.
  //
  // A lead with no creator (the website's own inserts) is nobody's, so only
  // an owner retires it.
  const isMine = !!draft.created_by && draft.created_by === user?.id;
  const mayRetire = can(role, "retire_leads") || isMine;
  const settableStatuses = LEADS_SETTABLE_STATUSES.filter(
    (s) => mayRetire || (s.key !== "lost" && s.key !== "archived")
  );

  return (
    <>
      {error && <p className="detail__error">{error}</p>}

      <div className="detail__grid">
        <Field label="Name">
          <input className="detail__input" value={draft.name || ""}
            onChange={(e) => set("name", e.target.value)} />
        </Field>

        <Field label="Status">
          <select className="detail__input" value={draft.status}
            onChange={(e) => set("status", e.target.value)}>
            {/* Always show the lead's current status, even if it isn't
                normally settable here — a scheduled lead viewed directly,
                or a lead already Lost being read by someone who couldn't
                set it. Checked against the FILTERED list, not the full one,
                or a tech opening a lost lead would see the select snap to
                Contacted and silently reopen it on save. */}
            {!settableStatuses.some((s) => s.key === draft.status) && (
              <option value={draft.status}>{draft.status}</option>
            )}
            {settableStatuses.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          {/* Said out loud rather than left as a gap. Two options quietly
              missing from a dropdown reads as a bug; a sentence reads as a
              rule. */}
          {!mayRetire && (
            <p className="detail__statushint">
              Only an owner can mark someone else&rsquo;s lead lost or
              archived.
            </p>
          )}
        </Field>

        <Field label="Phone">
          {/* The box, and nothing else.

              The Call button, "Last reached out ... 4 attempts" and the
              link to the history all used to live here, which made the
              field somebody opens to fix a typo into the page's busiest
              corner. All three are on the Communication page now, where
              they sit beside the conversation they belong to. */}
          <input className="detail__input" type="tel" value={draft.phone || ""}
            onChange={(e) => set("phone", e.target.value)} />
        </Field>

        <Field label="Email">
          <input className="detail__input" type="email" value={draft.email || ""}
            onChange={(e) => set("email", e.target.value)} />
        </Field>

        <Field label="Address" full>
          <AddressPicker
            value={draft.address || ""}
            inputClassName="detail__input"
            placeholder="Start typing an address…"
            onChange={({ address, latitude, longitude }) => {
              setForm((f) => ({ ...(f ?? lead), address, latitude, longitude }));
            }}
            // Text alone does not clear the coordinates. This is an EDIT
            // form: the lead may already have a pin from the map or the
            // website, and fixing a typo in the street name would otherwise
            // throw it away. Picking a suggestion is how you move a pin.
            onTextChange={(text) => set("address", text)}
          />
        </Field>

        <Field label="Stories">
          <select className="detail__input" value={draft.stories}
            onChange={(e) => set("stories", e.target.value)}>
            <option value="one">One story</option>
            <option value="two">Two story</option>
          </select>
        </Field>

        <Field label="Windows">
          <input className="detail__input" type="number" min="1" value={draft.windows}
            onChange={(e) => set("windows", e.target.value)} />
        </Field>

        <Field label="Estimate ($)">
          <input className="detail__input" type="number" min="0" value={draft.estimate}
            onChange={(e) => set("estimate", e.target.value)} />
        </Field>

        <Field label="Temperature">
          <select className="detail__input" value={draft.temperature || ""}
            onChange={(e) => set("temperature", e.target.value)}>
            <option value="">— not set —</option>
            {TEMPERATURES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Where they came from">
          <select className="detail__input" value={draft.source || "door"}
            onChange={(e) => set("source", e.target.value)}>
            {/* Keep an unrecognised value selectable rather than silently
                switching the lead to Door knock the next time anyone opens
                it. Same guard the status select uses. */}
            {!LEAD_SOURCES.some((s) => s.key === (draft.source || "door")) && (
              <option value={draft.source}>{draft.source}</option>
            )}
            {LEAD_SOURCES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>

        {/* Attribution, right next to how the lead arrived, because the two
            corrections tend to happen in the same breath: "that was
            Trenton's, from a job site" is one thought.

            Saves immediately rather than waiting for Save changes. It isn't
            a form field — it moves money — so it goes through its own
            database function and reports back what happened to the fee. */}
        {can(role, "reassign_leads") && (
        <Field label="Added by">
          <select
            className="detail__input"
            value={draft.created_by || ""}
            disabled={reassigning}
            onChange={(e) => handleReassign(e.target.value)}
          >
            <option value="">Nobody / website</option>
            {/* An attribution to someone no longer active still has to
                render, or the select would silently jump to the first name
                on the list. */}
            {draft.created_by &&
              !owners.some((o) => o.id === draft.created_by) && (
                <option value={draft.created_by}>
                  {draft.creator?.full_name || "(former rep)"}
                </option>
              )}
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.full_name || "(unnamed)"}
                {o.commission_eligible === false ? " — no commission" : ""}
              </option>
            ))}
          </select>
          {reassigning && (
            <p className="detail__statushint">Moving the finder&rsquo;s fee…</p>
          )}
          {reassignNote && !reassigning && (
            <p className="detail__reassigned">{reassignNote}</p>
          )}
        </Field>
        )}

        <Field label="Service they asked about">
          {/* No default applied here, unlike source. A website lead carries
              the service the customer picked; a lead with nothing recorded
              predates the service column, and quietly relabelling it as
              window washing would invent an answer it never had. */}
          <select className="detail__input" value={draft.service || ""}
            onChange={(e) => set("service", e.target.value || null)}>
            <option value="">— not recorded —</option>
            {draft.service && !SERVICE_TYPES.some((s) => s.key === draft.service) && (
              <option value={draft.service}>{serviceFor(draft.service).label}</option>
            )}
            {SERVICE_TYPES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Interior cleaning">
          <label className="detail__check">
            <input type="checkbox" checked={draft.interior}
              onChange={(e) => set("interior", e.target.checked)} />
            <span>Included</span>
          </label>
        </Field>

        <div className="detail__field detail__field--full">
          <PlanPicker
            propertyType={draft.property_type || "residential"}
            plan={draft.service_plan || "one_time"}
            onPropertyTypeChange={(v) => set("property_type", v)}
            onPlanChange={(v) => set("service_plan", v)}
            basePrice={draft.estimate}
          />
        </div>

        <div className="detail__field detail__field--full">
          <AppointmentPicker
            date={apptDateValue}
            time={apptTimeValue}
            onDateChange={setApptDate}
            onTimeChange={setApptTime}
          />
        </div>

        <Field label="Customer notes" full>
          <textarea className="detail__input detail__textarea" rows="2"
            value={draft.notes || ""}
            onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <Field label="Internal notes (team only)" full>
          <textarea className="detail__input detail__textarea" rows="3"
            placeholder="Called 8/4, left voicemail…"
            value={draft.crm_notes || ""}
            onChange={(e) => set("crm_notes", e.target.value)} />
        </Field>
      </div>

      {/* QUOTES AND THE TEXT THREAD USED TO BE HERE, stacked under this
          draft. They are on their own pages now, reached by the two buttons
          at the top — see RecordTabs.jsx.

          `persist` is still called before sending a quote, but from the
          quotes page's own flow rather than from a beforeSend hook passed
          down from here: that hook existed because "Save changes" on THIS
          page also navigates away, and people lost what they had typed.
          There is no form to lose on the quotes page. */}

      {/* Collapsed by default, because it is the longest thing on the page
          and the least often wanted. A lead that has been worked for a
          month carries a dozen rows of "Contacted -> Quoted"; a lead
          somebody opened to fix an address carries none of the answers
          they came for. The count is on the button, so the common question
          — "has anything happened to this one?" — is answered without
          opening it. */}
      {events.length > 0 && (
        <div className="detail__history">
          <div className="detail__historyhead">
            <h2 className="detail__historytitle">
              Status history{loading ? " · loading…" : ""}
            </h2>
            <button
              type="button"
              className="detail__historytoggle"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
            >
              {historyOpen ? "Hide" : `Show (${visibleEvents.length})`}
            </button>
          </div>
          {historyOpen && (
          <ol className="detail__timeline">
            {visibleEvents.map((ev) => (
              <li key={ev.id} className="detail__event">
                <span className="detail__eventdot" />
                <span className="detail__eventtext">
                  {ev.from_status ? (
                    <>
                      {statusLabel(ev.from_status)} →{" "}
                      <strong>{statusLabel(ev.to_status)}</strong>
                    </>
                  ) : (
                    <>
                      Created as <strong>{statusLabel(ev.to_status)}</strong>
                    </>
                  )}
                </span>
                <span className="detail__eventdate">
                  {ev.actor?.full_name && (
                    <span className="detail__eventactor">
                      {ev.actor.full_name}
                    </span>
                  )}
                  {formatEventDate(ev.created_at)}
                </span>
              </li>
              ))}
          </ol>
          )}
        </div>
      )}

      <div className="detail__actions">
        <button className="detail__save" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button className="detail__cancel" onClick={() => navigate("/leads")}>
          Cancel
        </button>

        {/* Owners only. A deleted lead is a row gone from the database
            along with its event history, and there is no undo anywhere in
            the CRM — so the button isn't dimmed for a tech, it's absent.
            A disabled control invites a support conversation; a missing one
            doesn't raise the question. */}
        {canDelete && (
        <div className="detail__delete-wrap">
          {confirmDelete ? (
            <>
              <span className="detail__confirm-text">Delete permanently?</span>
              <button className="detail__delete-yes" onClick={handleDelete}>
                Yes, delete
              </button>
              <button className="detail__cancel" onClick={() => setConfirmDelete(false)}>
                No
              </button>
            </>
          ) : (
            <button className="detail__delete" onClick={() => setConfirmDelete(true)}>
              Delete lead
            </button>
          )}
        </div>
        )}
      </div>
    </>
  );
}

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}

function formatEventDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// formatContacted() lived here and has moved to LeadComms.jsx as
// whenReached(), where the "Last reached out" line now lives. Its
// calendar-day bug was fixed on the way: it divided the elapsed
// milliseconds by 86,400,000, so a call at 11pm read at 1am was two hours
// old and therefore "today at 11:00 PM". It was yesterday.

function Field({ label, children, full }) {
  return (
    <div className={`detail__field ${full ? "detail__field--full" : ""}`}>
      <label className="detail__label">{label}</label>
      {children}
    </div>
  );
}