import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ALL_STATUSES,
  fetchAllLeads,
  bulkUpdateLeadStatus,
  bulkDeleteLeads,
} from "../../services/leadService";
import ViewSwitcher from "../../components/ViewSwitcher";
import { LEAD_VIEWS } from "../../components/navViews";
import "./AllLeads.css";

const STATUS_LABEL = Object.fromEntries(
  ALL_STATUSES.map((s) => [s.key, s.label])
);

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// `views` decides which switcher shows, because this page is mounted under
// both /leads/all and /customers/leads.
export default function AllLeads({ views = LEAD_VIEWS }) {
  const navigate = useNavigate();

  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("created_desc");
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // Holds the pending destructive action until it's confirmed.
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [alsoDeleteCustomers, setAlsoDeleteCustomers] = useState(false);
  // Force mode deletes jobs too. Gated behind typing DELETE, because it
  // destroys payment history rather than just pipeline clutter.
  const [forceDelete, setForceDelete] = useState(false);
  const [forceConfirmText, setForceConfirmText] = useState("");

  // Load once on mount. The work lives inside the effect so no state is set
  // synchronously during render, and `cancelled` stops a slow response from
  // writing to a component the user has already navigated away from.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await fetchAllLeads();
        if (cancelled) return;
        setLeads(data);
        setError("");
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load leads. Refresh to try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // How many leads sit in each status — drives the filter chip counts.
  const counts = useMemo(() => {
    const map = { all: leads.length };
    for (const s of ALL_STATUSES) map[s.key] = 0;
    for (const lead of leads) {
      map[lead.status] = (map[lead.status] || 0) + 1;
    }
    return map;
  }, [leads]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    let rows = leads.filter((lead) => {
      if (statusFilter !== "all" && lead.status !== statusFilter) return false;
      if (!term) return true;
      return [lead.name, lead.address, lead.phone, lead.email]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });

    rows = [...rows];
    switch (sortBy) {
      case "created_asc":
        rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        break;
      case "name":
        rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        break;
      case "status":
        rows.sort((a, b) => (a.status || "").localeCompare(b.status || ""));
        break;
      default:
        rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return rows;
  }, [leads, statusFilter, search, sortBy]);

  // Selection is kept across filter changes, but the header checkbox only
  // reflects what's currently on screen.
  const visibleIds = visible.map((l) => l.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const selectedLeads = leads.filter((l) => selected.has(l.id));
  const selectedWithJobs = selectedLeads.filter((l) => l.jobCount > 0);

  // Force is only actually armed once the checkbox is ticked AND the word
  // is typed — the button stays inert otherwise.
  const forceUnlocked = forceDelete && forceConfirmText.trim() === "DELETE";
  const deletableLeads = forceUnlocked
    ? selectedLeads
    : selectedLeads.filter((l) => !l.jobCount);
  const deletableCount = deletableLeads.length;
  const jobsAtRisk = selectedWithJobs.reduce((sum, l) => sum + l.jobCount, 0);
  // Customer profiles that would come along, split by whether removing them
  // is safe — i.e. they have no jobs of their own.
  const safeCustomers = deletableLeads.filter((l) => l.customer?.safeToDelete);
  const unsafeCustomers = deletableLeads.filter(
    (l) => l.customer && !l.customer.safeToDelete
  );

  function toggleOne(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleBulkStatus(status) {
    if (!status || selected.size === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const ids = [...selected];
      await bulkUpdateLeadStatus(ids, status);
      setLeads((cur) =>
        cur.map((l) => (selected.has(l.id) ? { ...l, status } : l))
      );
      setNotice(
        `Moved ${ids.length} lead${ids.length === 1 ? "" : "s"} to ${
          STATUS_LABEL[status] || status
        }.`
      );
      clearSelection();
    } catch (e) {
      console.error(e);
      setError("Couldn't update those leads. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmedDelete() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const {
        deleted,
        blocked,
        jobsDeleted,
        customersDeleted,
        customersKept,
      } = await bulkDeleteLeads(selectedLeads, {
        alsoDeleteCustomers,
        force: forceUnlocked,
      });

      if (deleted.length > 0) {
        const gone = new Set(deleted);
        setLeads((cur) => cur.filter((l) => !gone.has(l.id)));
      }

      let message = deleted.length
        ? `Deleted ${deleted.length} lead${deleted.length === 1 ? "" : "s"}.`
        : "Nothing was deleted.";

      if (jobsDeleted > 0) {
        message += ` Removed ${jobsDeleted} job${
          jobsDeleted === 1 ? "" : "s"
        } and their payment history.`;
      }

      if (customersDeleted > 0) {
        message += ` Removed ${customersDeleted} customer profile${
          customersDeleted === 1 ? "" : "s"
        }.`;
      }

      if (customersKept?.length > 0) {
        const kept = customersKept
          .map((c) => `${c.name || "Unnamed"} (${c.reason})`)
          .join(", ");
        message += ` Kept ${customersKept.length} customer profile${
          customersKept.length === 1 ? "" : "s"
        }: ${kept}.`;
      }

      if (blocked.length > 0) {
        const names = blocked
          .map((b) => `${b.name || "Unnamed"} (${b.jobCount})`)
          .join(", ");
        message += ` Kept ${blocked.length} lead${
          blocked.length === 1 ? "" : "s"
        } with job history: ${names}. Archive those instead.`;
      }

      setNotice(message);
      clearSelection();
      setAlsoDeleteCustomers(false);
      setForceDelete(false);
      setForceConfirmText("");
    } catch (e) {
      console.error(e);
      setError("Couldn't delete those leads. Try again.");
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  }

  if (loading) return <div className="allleads__state">Loading leads…</div>;


  return (
    <div className="allleads">
      <ViewSwitcher views={views} />

      <div className="allleads__head">
        <div>
          <h1 className="allleads__title">All leads</h1>
          <p className="allleads__sub">
            Every lead ever created, including scheduled, completed and
            archived ones that leave the pipeline board.
          </p>
        </div>
        <span className="allleads__total">{leads.length} total</span>
      </div>

      {error && <p className="allleads__error">{error}</p>}
      {notice && <p className="allleads__notice">{notice}</p>}

      <div className="allleads__filters">
        <button
          className={`allleads__chip ${
            statusFilter === "all" ? "allleads__chip--active" : ""
          }`}
          onClick={() => setStatusFilter("all")}
        >
          All <span className="allleads__chipcount">{counts.all}</span>
        </button>
        {ALL_STATUSES.map((s) => (
          <button
            key={s.key}
            className={`allleads__chip ${
              statusFilter === s.key ? "allleads__chip--active" : ""
            }`}
            onClick={() => setStatusFilter(s.key)}
          >
            {s.label}{" "}
            <span className="allleads__chipcount">{counts[s.key] || 0}</span>
          </button>
        ))}
      </div>

      <div className="allleads__tools">
        <input
          className="allleads__search"
          type="search"
          placeholder="Search name, address, phone or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="allleads__sort"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="created_desc">Newest first</option>
          <option value="created_asc">Oldest first</option>
          <option value="name">Name A–Z</option>
          <option value="status">Status</option>
        </select>
      </div>

      {selected.size > 0 && (
        <div className="allleads__bulk">
          <span className="allleads__bulkcount">
            {selected.size} selected
            {selectedWithJobs.length > 0 && (
              <em className="allleads__bulkwarn">
                {" "}
                · {selectedWithJobs.length} with job history
              </em>
            )}
          </span>

          <select
            className="allleads__bulkstatus"
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              handleBulkStatus(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">Move to…</option>
            {ALL_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>

          {/* Always reachable while something is selected — the dialog is
              where job history gets explained and force is unlocked. */}
          <button
            className="allleads__delete"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete {deletableCount > 0 ? deletableCount : ""}
          </button>

          <button className="allleads__clear" onClick={clearSelection}>
            Clear
          </button>
        </div>
      )}

      <div className="allleads__tablewrap">
        <table className="allleads__table">
          <thead>
            <tr>
              <th className="allleads__checkcol">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label="Select all visible leads"
                />
              </th>
              <th>Name</th>
              <th>Address</th>
              <th>Contact</th>
              <th>Status</th>
              <th>Jobs</th>
              <th className="allleads__custcol">Customer</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan="8" className="allleads__empty">
                  No leads match that filter.
                </td>
              </tr>
            )}

            {visible.map((lead) => (
              <tr
                key={lead.id}
                className={selected.has(lead.id) ? "allleads__row--sel" : ""}
              >
                <td className="allleads__checkcol">
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggleOne(lead.id)}
                    aria-label={`Select ${lead.name || "lead"}`}
                  />
                </td>
                <td>
                  <button
                    className="allleads__name"
                    onClick={() => navigate(`/leads/${lead.id}`)}
                  >
                    {lead.name || "Unnamed"}
                  </button>
                </td>
                <td className="allleads__muted">{lead.address || "—"}</td>
                <td className="allleads__muted">
                  {lead.phone || lead.email || "—"}
                </td>
                <td>
                  <span
                    className={`allleads__status allleads__status--${lead.status}`}
                  >
                    {STATUS_LABEL[lead.status] || lead.status}
                  </span>
                </td>
                <td className="allleads__muted">
                  {lead.jobCount > 0 ? lead.jobCount : "—"}
                </td>
                <td className="allleads__muted allleads__custcol">
                  {lead.customer ? lead.customer.name || "Unnamed" : "—"}
                </td>
                <td className="allleads__muted">
                  {formatDate(lead.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDelete && (
        <div
          className="allleads__backdrop"
          onClick={() => {
            setConfirmDelete(null);
            setForceDelete(false);
            setForceConfirmText("");
          }}
        >
          <div
            className="allleads__modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2 className="allleads__modaltitle">
              {deletableCount > 0
                ? `Delete ${deletableCount} lead${
                    deletableCount === 1 ? "" : "s"
                  }?`
                : "Nothing can be deleted yet"}
            </h2>
            <p className="allleads__modaltext">
              {deletableCount > 0
                ? "This permanently removes them from the database. It can't be undone."
                : "Every lead you selected has job history. Tick the box below if you're clearing test data."}
            </p>

            {selectedWithJobs.length > 0 && !forceDelete && (
              <p className="allleads__modalwarn">
                {selectedWithJobs.length} of the selected lead
                {selectedWithJobs.length === 1 ? " has" : "s have"} job history
                ({jobsAtRisk} job{jobsAtRisk === 1 ? "" : "s"}) and will be
                kept — deleting them would destroy payment history your Income
                page reports from.
              </p>
            )}

            {selectedWithJobs.length > 0 && (
              <div className="allleads__force">
                <label className="allleads__modalcheck">
                  <input
                    type="checkbox"
                    checked={forceDelete}
                    onChange={(e) => {
                      setForceDelete(e.target.checked);
                      if (!e.target.checked) setForceConfirmText("");
                    }}
                    disabled={busy}
                  />
                  <span>
                    Delete their {jobsAtRisk} job
                    {jobsAtRisk === 1 ? "" : "s"} too
                    <em className="allleads__modalhint">
                      For clearing test data. This permanently removes the
                      jobs, their tech assignments and their payment records —
                      your Income totals will change.
                    </em>
                  </span>
                </label>

                {forceDelete && (
                  <>
                    <label className="allleads__forcelabel">
                      Type <strong>DELETE</strong> to confirm
                    </label>
                    <input
                      className="allleads__forceinput"
                      type="text"
                      value={forceConfirmText}
                      onChange={(e) => setForceConfirmText(e.target.value)}
                      placeholder="DELETE"
                      autoComplete="off"
                      disabled={busy}
                    />
                  </>
                )}
              </div>
            )}

            {safeCustomers.length > 0 && (
              <label className="allleads__modalcheck">
                <input
                  type="checkbox"
                  checked={alsoDeleteCustomers}
                  onChange={(e) => setAlsoDeleteCustomers(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  Also delete {safeCustomers.length} customer profile
                  {safeCustomers.length === 1 ? "" : "s"}
                  <em className="allleads__modalhint">
                    {safeCustomers
                      .map((l) => l.customer.name || "Unnamed")
                      .join(", ")}
                    . No jobs are attached to these, so nothing else depends
                    on them.
                  </em>
                </span>
              </label>
            )}

            {unsafeCustomers.length > 0 && (
              <p className="allleads__modalhint allleads__modalhint--block">
                {unsafeCustomers.length} customer profile
                {unsafeCustomers.length === 1 ? "" : "s"} will be kept
                regardless —{" "}
                {unsafeCustomers
                  .map(
                    (l) =>
                      `${l.customer.name || "Unnamed"} (${
                        l.customer.jobCount
                      } job${l.customer.jobCount === 1 ? "" : "s"})`
                  )
                  .join(", ")}
                .
              </p>
            )}

            <div className="allleads__modalactions">
              <button
                className="allleads__confirm"
                onClick={handleConfirmedDelete}
                disabled={
                  busy ||
                  deletableCount === 0 ||
                  (forceDelete && !forceUnlocked)
                }
              >
                {busy
                  ? "Deleting…"
                  : forceDelete && !forceUnlocked
                    ? "Type DELETE to confirm"
                    : `Delete ${deletableCount}`}
              </button>
              <button
                className="allleads__cancel"
                onClick={() => {
                  setConfirmDelete(null);
                  setForceDelete(false);
                  setForceConfirmText("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
