import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PIPELINE_STAGES,
  STALE_AFTER_DAYS,
  fetchActiveLeads,
  updateLead,
  bulkUpdateLeadStatus,
  recordLeadContact,
  missingFieldFor,
} from "../../services/leadService";
import LeadColumn from "../../components/LeadColumn";
import ViewSwitcher from "../../components/ViewSwitcher";
import ScopeToggle from "../../components/ScopeToggle";
import { initialScope } from "../../components/scopeMemory";
import { useAuth } from "../../context/useAuth";
import { can } from "../../components/capabilities";
import { LEAD_VIEWS } from "../../components/navViews";
import DragPromptModal from "../../components/DragPromptModal";
import "./Leads.css";

// Where the Add lead button lands. Contacted is the first stage you can add
// to by hand and the commonest place a knocked door ends up; the form lets
// you change it before saving, so this is a starting point, not a rule.
const DEFAULT_ADD_STAGE = "contacted";

// Load persisted collapse state (survives navigation + refresh).
function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem("leadsCollapsed")) || {};
  } catch {
    return {};
  }
}

export default function Leads() {
  const navigate = useNavigate();
  const { user, role } = useAuth();
  // One press archives every stale lead at once. All of them are past
  // the 30-day gate by definition, so it can void several reps' pending
  // commissions in a single action — the largest lever on this page.
  const canBulkArchive = can(role, "bulk_archive_leads");
  // Seeded from storage rather than defaulted then corrected, so the board
  // never flashes the whole team's leads before narrowing to yours.
  const [scope, setScope] = useState(initialScope);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingMove, setPendingMove] = useState(null);
  // { new: true, contacted: false, ... } — which columns are collapsed.
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // Show only leads that have sat untouched past the threshold.
  const [staleOnly, setStaleOnly] = useState(false);
  const [archiving, setArchiving] = useState(false);

  async function loadLeads() {
    try {
      const data = await fetchActiveLeads(scope === "mine" ? user?.id : null);
      setLeads(data);
      setError("");
    } catch (e) {
      console.error(e);
      setError("Couldn't load leads. Refresh to try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Started inside the effect rather than called directly, so its
    // state updates land after the await instead of synchronously
    // during the effect (react-hooks/set-state-in-effect).
    void (async () => {
      await loadLeads();
    })();
    // loadLeads is redefined every render and reads `scope` from the
    // closure, so listing it here would refetch on every render. The two
    // values it actually depends on are named instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, user?.id]);

  // Persist collapse state whenever it changes.
  useEffect(() => {
    localStorage.setItem("leadsCollapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  function toggleCollapse(stageKey) {
    setCollapsed((cur) => ({ ...cur, [stageKey]: !cur[stageKey] }));
  }

  async function commitMove(leadId, changes, previousLeads) {
    setLeads((cur) =>
      cur.map((l) => (l.id === leadId ? { ...l, ...changes } : l))
    );
    try {
      await updateLead(leadId, changes);
    } catch (e) {
      console.error(e);
      setLeads(previousLeads);
      setError("Couldn't save that change. Try again.");
    }
  }

  // Tapping a phone number dials it and records the attempt. The dialer
  // opens over the page rather than unloading it, so the write does get to
  // finish — but it's still fire-and-forget from the user's point of view,
  // which is why the row is patched locally first and only rolled back if
  // the server disagrees.
  async function handleContact(lead) {
    const previous = leads;
    setLeads((cur) =>
      cur.map((l) =>
        l.id === lead.id
          ? {
              ...l,
              last_contacted_at: new Date().toISOString(),
              contact_attempts: (l.contact_attempts || 0) + 1,
              // Mirrors the rule in record_lead_contact: only a lead still
              // on 'new' moves. Anything further along keeps its place.
              status: l.status === "new" ? "contacted" : l.status,
            }
          : l
      )
    );
    try {
      const updated = await recordLeadContact(lead.id);
      if (updated) {
        setLeads((cur) => cur.map((l) => (l.id === lead.id ? { ...l, ...updated } : l)));
      }
    } catch (e) {
      console.error(e);
      setLeads(previous);
      setError("Couldn't record that call. The number still dialled.");
    }
  }

  function handleMove(lead, newStatus) {
    if (lead.status === newStatus) return;

    const missing = missingFieldFor(newStatus, lead);
    if (missing.length > 0) {
      setPendingMove({ lead, newStatus, missing, previousLeads: leads });
    } else {
      commitMove(lead.id, { status: newStatus }, leads);
    }
  }

  // `values` is keyed by field name now that a move can be short of more
  // than one thing at a time.
  function handlePromptConfirm(values, extras) {
    const { lead, newStatus, previousLeads } = pendingMove;
    const changes = { status: newStatus, ...(extras || {}) };
    if (values.price != null) changes.estimate = Number(values.price);
    if (values.appointment) changes.appointment_at = values.appointment;
    commitMove(lead.id, changes, previousLeads);
    setPendingMove(null);
  }

  function handlePromptCancel() {
    setPendingMove(null);
  }

  // Sweep every stale lead into archived in one go. Deliberately a manual
  // action rather than a timed job — you stay the one deciding, and the
  // threshold can move without rewriting any data.
  async function handleArchiveStale() {
    const ids = staleLeads.map((l) => l.id);
    if (ids.length === 0) return;
    setArchiving(true);
    try {
      await bulkUpdateLeadStatus(ids, "archived");
      const gone = new Set(ids);
      setLeads((cur) => cur.filter((l) => !gone.has(l.id)));
      setStaleOnly(false);
    } catch (e) {
      console.error(e);
      setError("Couldn't archive those leads. Try again.");
    } finally {
      setArchiving(false);
    }
  }

  if (loading) {
    return <div className="leads__state">Loading leads…</div>;
  }

  const stageLabel = (key) =>
    PIPELINE_STAGES.find((s) => s.key === key)?.label ?? key;

  const staleLeads = leads.filter((l) => l.stale);
  const shown = staleOnly ? staleLeads : leads;

  return (
    <div className="leads">
      <ViewSwitcher views={LEAD_VIEWS} section="leads" />

      {/* The switcher is the visible heading — a repeated "Pipeline" title
          directly under it was pure duplication. The h1 stays for screen
          readers and document structure, just hidden visually. */}
      <h1 className="visually-hidden">Pipeline</h1>

      <div className="leads__bar">
        {/* Grouped so the count and the filter that produces it stay
            together when the bar wraps on a narrow screen — otherwise the
            number ends up on one line and what it counts on another. */}
        <div className="leads__barleft">
          <p className="leads__count">{leads.length} active</p>
          <ScopeToggle scope={scope} onChange={setScope} />
        </div>
        {/* One button rather than a "+" on every stage. Three blue chips
            competed with the cards for attention, and the stage they added
            to is now chosen on the form itself — where it can also be
            changed after the fact, which the chips never allowed. */}
        <button
          className="leads__add"
          onClick={() => navigate(`/leads/new/${DEFAULT_ADD_STAGE}`)}
        >
          + Add lead
        </button>
      </div>

      {error && <p className="leads__error">{error}</p>}

      {staleLeads.length > 0 && (
        <div className="leads__stalebar">
          <span className="leads__staletext">
            {staleLeads.length} lead{staleLeads.length === 1 ? "" : "s"} with no
            change in {STALE_AFTER_DAYS}+ days
          </span>
          <button
            className={`leads__stalebtn ${staleOnly ? "leads__stalebtn--on" : ""}`}
            onClick={() => setStaleOnly((v) => !v)}
          >
            {staleOnly ? "Show all" : "Show only these"}
          </button>
          {canBulkArchive && (
            <button
              className="leads__archivebtn"
              onClick={handleArchiveStale}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : `Archive all ${staleLeads.length}`}
            </button>
          )}
        </div>
      )}

      <div className="leads__board">
        {PIPELINE_STAGES.map((stage) => (
          <LeadColumn
            key={stage.key}
            stage={stage}
            leads={shown.filter((l) => l.status === stage.key)}
            collapsed={!!collapsed[stage.key]}
            onToggle={() => toggleCollapse(stage.key)}
            onMove={handleMove}
            onContact={handleContact}
          />
        ))}
      </div>

      {pendingMove && (
        <DragPromptModal
          fields={pendingMove.missing}
          stageLabel={stageLabel(pendingMove.newStatus)}
          lead={pendingMove.lead}
          askPlan={pendingMove.newStatus === "booked"}
          onConfirm={handlePromptConfirm}
          onCancel={handlePromptCancel}
        />
      )}
    </div>
  );
}