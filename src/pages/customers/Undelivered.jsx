import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ViewSwitcher from "../../components/ViewSwitcher";
import { CUSTOMER_VIEWS } from "../../components/navViews";
import {
  channelWord,
  clearClosedEmail,
  clearUnreachable,
  failureLabel,
  fetchClosedEmails,
  fetchFailures,
  fetchUnreachable,
  formatPhone,
  jobWhen,
  kindLabel,
  shortWhen,
  urgency,
  whatToDo,
} from "../../services/deliveryService";
import "./Undelivered.css";

/**
 * Messages that didn't arrive.
 *
 * This page exists because until now there was nowhere for this to be. A
 * quote to a landline was recorded as sent, looked from the inside exactly
 * like one the customer had read, and the only way to find out otherwise was
 * to open the Quo app and notice. An email was worse: nothing was recorded
 * at all.
 *
 * Three lists, deliberately separate, because they call for different things:
 *
 *   Didn't arrive   — one message, one customer, one thing to do about it.
 *   Closed numbers  — a standing fact about a phone.
 *   Closed addresses— a standing fact about an inbox.
 *
 * Rolling them together would bury nine one-off failures under one landline,
 * or make a permanent fact look like nine separate problems.
 */
export default function Undelivered() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [closedMail, setClosedMail] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [failures, closed, closedEmails] = await Promise.all([
        fetchFailures(),
        fetchUnreachable(),
        fetchClosedEmails(),
      ]);
      setRows(failures);
      setBlocked(closed);
      setClosedMail(closedEmails);
      setError("");
    } catch (e) {
      console.error("Couldn't load undelivered messages:", e);
      // Named, not hidden. Everyone who reaches this page is signed in, and
      // "something went wrong" sends somebody to the browser console for a
      // message the code already has.
      setError(e?.message || "Couldn't load this.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function reopen(kind, value) {
    setBusy(value);
    try {
      if (kind === "email") await clearClosedEmail(value);
      else await clearUnreachable(value);
      await load();
    } catch (e) {
      console.error("Couldn't reopen that:", e);
      setError(e?.message || "Couldn't reopen that.");
    } finally {
      setBusy(null);
    }
  }

  // Where a row goes when you press it.
  //
  // The JOB first when there is one, because a failed day-before
  // confirmation is a question about tomorrow morning — who is going, what
  // time, can somebody call ahead — and all of that is on the job, not on
  // the customer record.
  function open(row) {
    if (row.kind === "reminder" && row.job_id) navigate(`/jobs/${row.job_id}`);
    else if (row.customer_id) navigate(`/customers/${row.customer_id}`);
    else if (row.lead_id) navigate(`/leads/${row.lead_id}`);
  }

  function targetOf(row) {
    if (row.kind === "reminder" && row.job_id) return true;
    return Boolean(row.customer_id || row.lead_id);
  }

  const urgent = rows.filter((r) => urgency(r) === 2).length;

  return (
    <div className="undel">
      <h1 className="visually-hidden">Messages that didn&rsquo;t arrive</h1>
      <ViewSwitcher views={CUSTOMER_VIEWS} section="customers" />

      {error && <p className="undel__error">{error}</p>}

      {/* Above everything, including the closed lists. A job tomorrow that
          the customer has not been told about is the only thing on this
          page with a deadline on it. */}
      {urgent > 0 && (
        <p className="undel__alarm">
          {urgent === 1
            ? "One customer has not been told we're coming."
            : `${urgent} customers have not been told we're coming.`}{" "}
          Call them today.
        </p>
      )}

      {blocked.length > 0 && (
        <section className="undel__section">
          <h2 className="undel__head">
            Numbers closed to texts
            <span className="undel__count">{blocked.length}</span>
          </h2>
          <p className="undel__lede">
            A carrier refused these permanently &mdash; usually a landline.
            Nothing else will be texted to them. Reopen one if they&rsquo;ve
            changed number or the digits were wrong; if the carrier refuses it
            again it closes itself.
          </p>

          <ul className="undel__blocked">
            {blocked.map((b) => (
              <li className="blockedrow" key={b.phone}>
                <div className="blockedrow__main">
                  <a className="blockedrow__phone" href={`tel:${b.phone}`}>
                    {formatPhone(b.phone)}
                  </a>
                  <span className="blockedrow__reason">{b.reason}</span>
                </div>
                <span className="blockedrow__when">
                  {b.failures > 1 ? `${b.failures} refusals, last ` : ""}
                  {shortWhen(b.last_at)}
                </span>
                <button
                  className="blockedrow__reopen"
                  onClick={() => reopen("phone", b.phone)}
                  disabled={busy === b.phone}
                >
                  {busy === b.phone ? "Reopening…" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closedMail.length > 0 && (
        <section className="undel__section">
          <h2 className="undel__head">
            Addresses closed to email
            <span className="undel__count">{closedMail.length}</span>
          </h2>
          <p className="undel__lede">
            These bounced permanently or reported us as spam. Nothing else
            will be emailed to them.
          </p>

          <ul className="undel__blocked">
            {closedMail.map((b) => (
              <li
                className={`blockedrow${b.complained ? " blockedrow--spam" : ""}`}
                key={b.email}
              >
                <div className="blockedrow__main">
                  <a className="blockedrow__phone" href={`mailto:${b.email}`}>
                    {b.email}
                  </a>
                  <span className="blockedrow__reason">
                    {/* A complaint is a person saying stop. It is not the
                        same fact as a full mailbox and must not read like
                        one — reopening it is a decision, not a tidy-up. */}
                    {b.complained ? "Marked us as spam" : b.reason}
                  </span>
                </div>
                <span className="blockedrow__when">
                  {b.failures > 1 ? `${b.failures} refusals, last ` : ""}
                  {shortWhen(b.last_at)}
                </span>
                <button
                  className="blockedrow__reopen"
                  onClick={() => reopen("email", b.email)}
                  disabled={busy === b.email || b.complained}
                  title={
                    b.complained
                      ? "They reported us as spam. Ask them first."
                      : undefined
                  }
                >
                  {busy === b.email ? "Reopening…" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="undel__section">
        <h2 className="undel__head">
          Didn&rsquo;t arrive
          {rows.length > 0 && <span className="undel__count">{rows.length}</span>}
        </h2>

        {loading ? (
          <p className="undel__state">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="undel__empty">
            Every message has reached the person it was sent to. Nothing to do
            here.
          </p>
        ) : (
          <ul className="undel__list">
            {rows.map((r) => {
              const pressable = targetOf(r);
              const isUrgent = urgency(r) === 2;
              return (
                <li
                  className={`undelrow undelrow--${r.status}${
                    isUrgent ? " undelrow--urgent" : ""
                  }`}
                  key={`${r.channel}:${r.id}`}
                  onClick={() => open(r)}
                  role={pressable ? "button" : undefined}
                  tabIndex={pressable ? 0 : undefined}
                >
                  <div className="undelrow__top">
                    <span className="undelrow__who">{r.who || "Unknown"}</span>
                    <span className={`undelrow__tag undelrow__tag--${r.status}`}>
                      {failureLabel(r)}
                    </span>
                    <span className="undelrow__when">
                      {shortWhen(r.created_at)}
                    </span>
                  </div>

                  <p className="undelrow__do">{whatToDo(r)}</p>

                  {/* The job, when there is one. "Call them today" with no
                      date on it makes somebody go and look up which job. */}
                  {r.kind === "reminder" && r.job_at && (
                    <p className="undelrow__job">Job: {jobWhen(r.job_at)}</p>
                  )}

                  <p className="undelrow__meta">
                    {kindLabel(r)} &middot; by {channelWord(r)} &middot;{" "}
                    {/* Both ways of reaching them, side by side. A failed
                        text with an email on file is a two-second fix, and a
                        page that makes you go and look it up is a page that
                        gets ignored. */}
                    {r.phone && (
                      <a
                        className="undelrow__phone"
                        href={`tel:${r.phone}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {formatPhone(r.phone)}
                      </a>
                    )}
                    {r.phone && r.email && " · "}
                    {r.email && (
                      <a
                        className="undelrow__email"
                        href={`mailto:${r.email}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.email}
                      </a>
                    )}
                  </p>

                  {r.error && (
                    <p className="undelrow__carrier">
                      {r.channel === "email" ? "Mail server: " : "Carrier: "}
                      {r.error}
                    </p>
                  )}
                  {r.detail && <p className="undelrow__body">{r.detail}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
