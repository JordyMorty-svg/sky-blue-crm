import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  fetchContactTimeline,
  recordContact,
  describeEvent,
  formatStamp,
} from "../../services/contactService";
import { ALL_STATUSES, telHref } from "../../services/leadService";
import "./ContactHistory.css";

/**
 * Everything that ever happened with one person.
 *
 * Reached from a lead (/history/lead/:id) or a customer
 * (/history/customer/:id) and resolves to the same timeline either way —
 * the same human has a lead row while you're chasing them and a customer
 * row once they book, and the database stitches those together.
 *
 * This page exists because outreach didn't belong on the lead editor. A
 * call has no status transition, so it rendered there as "Created as" with
 * nothing after it, and it vanished entirely once the lead became a
 * customer. Here it has somewhere to live that outlives the lead.
 */

// contact_log.kind is free text, so adding a channel is this array and
// CONTACT_KINDS in contactService.js — no migration.
const LOG_KINDS = [
  { key: "call", label: "Call" },
  { key: "text", label: "Text" },
  { key: "email", label: "Email" },
  { key: "note", label: "Note" },
];

function statusLabel(key) {
  return ALL_STATUSES.find((s) => s.key === key)?.label ?? key;
}

export default function ContactHistory() {
  const { kind, id } = useParams(); // kind: "lead" | "customer"
  const navigate = useNavigate();
  const { state } = useLocation();

  const [rows, setRows] = useState([]);
  const [person, setPerson] = useState(state?.person || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [logging, setLogging] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logKind, setLogKind] = useState("call");
  const [logDetail, setLogDetail] = useState("");

  const leadId = kind === "lead" ? id : null;
  const customerId = kind === "customer" ? id : null;

  // Whoever sent us here says where back goes; otherwise the person's own
  // page, which is where you'd want to end up anyway.
  const back = state?.from || `/${kind === "lead" ? "leads" : "customers"}/${id}`;

  async function load() {
    try {
      setRows(await fetchContactTimeline({ leadId, customerId }));
      setError("");
    } catch (e) {
      console.error(e);
      setError(
        "Couldn't load the history. If db/contact-history.sql hasn't been run yet, that's why."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  // Tapping the Call button: the number is dialling, so this just records
  // that it happened. No note — you're on the phone.
  async function handleCallLogged() {
    try {
      await recordContact({ leadId, customerId, kind: "call" });
      await load();
    } catch (e) {
      console.error(e);
      setError("Couldn't record that call. The number still dialled.");
    }
  }

  async function handleSaveLog(e) {
    e.preventDefault();
    const detail = logDetail.trim();

    // A note with no text is the empty row this form exists to stop. A call
    // or a text with no note is fine — the fact that it happened is the
    // point, and the timestamp carries the rest.
    if (logKind === "note" && !detail) {
      setError("Write something for the note, or pick a different kind.");
      return;
    }

    setLogging(true);
    setError("");
    try {
      await recordContact({
        leadId,
        customerId,
        kind: logKind,
        detail: detail || null,
      });
      setLogDetail("");
      setLogKind("call");
      setLogOpen(false);
      await load();
    } catch (err) {
      console.error(err);
      setError("Couldn't record that. Try again.");
    } finally {
      setLogging(false);
    }
  }

  const phone = telHref(person?.phone);

  if (loading) return <div className="chist__state">Loading history…</div>;

  return (
    <div className="chist">
      <button className="chist__back" onClick={() => navigate(back)}>
        ← Back
      </button>

      <header className="chist__head">
        <h1 className="chist__title">
          {person?.name ? `${person.name} — history` : "Contact history"}
        </h1>
        <p className="chist__blurb">
          Every call, status change and job for this person, whether they were
          a lead or a customer at the time.
        </p>
      </header>

      {error && <p className="chist__error">{error}</p>}

      <div className="chist__actions">
        {phone && (
          <a className="chist__call" href={phone} onClick={handleCallLogged}>
            Call {person.phone}
          </a>
        )}
        <button
          className="chist__log"
          onClick={() => setLogOpen((v) => !v)}
          aria-expanded={logOpen}
        >
          {logOpen ? "Cancel" : "Log a contact"}
        </button>
      </div>

      {logOpen && (
        <form className="chist__form" onSubmit={handleSaveLog}>
          <div className="chist__kinds" role="group" aria-label="What kind">
            {LOG_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={
                  "chist__kind" +
                  (logKind === k.key ? " chist__kind--active" : "")
                }
                aria-pressed={logKind === k.key}
                onClick={() => setLogKind(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>

          <textarea
            className="chist__note"
            rows="2"
            value={logDetail}
            onChange={(ev) => setLogDetail(ev.target.value)}
            placeholder={
              logKind === "note"
                ? "What happened?"
                : "Anything worth remembering (optional)"
            }
          />

          <button className="chist__save" type="submit" disabled={logging}>
            {logging ? "Saving…" : `Save ${LOG_KINDS.find((k) => k.key === logKind).label.toLowerCase()}`}
          </button>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="chist__empty">Nothing recorded yet.</p>
      ) : (
        <ol className="chist__timeline">
          {rows.map((row, i) => {
            const { title, meta, tone } = describeEvent(row, statusLabel);
            return (
              <li
                className={`chist__event chist__event--${tone}`}
                key={`${row.source}-${row.seq}-${i}`}
              >
                <span className="chist__dot" />
                <div className="chist__body">
                  <span className="chist__eventtitle">{title}</span>
                  {meta && <span className="chist__eventmeta">{meta}</span>}
                </div>
                <div className="chist__when">
                  <span>{formatStamp(row.at)}</span>
                  {row.actor && <span className="chist__actor">{row.actor}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
