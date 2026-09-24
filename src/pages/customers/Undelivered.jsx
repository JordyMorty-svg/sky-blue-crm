import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ViewSwitcher from "../../components/ViewSwitcher";
import { CUSTOMER_VIEWS } from "../../components/navViews";
import {
  clearUnreachable,
  failureLabel,
  fetchFailures,
  fetchUnreachable,
  formatPhone,
  shortWhen,
  whatToDo,
} from "../../services/deliveryService";
import "./Undelivered.css";

/**
 * Texts that didn't arrive.
 *
 * This page exists because until now there was nowhere for this to be. A
 * quote to a landline was recorded as sent, looked from the inside exactly
 * like one the customer had read, and the only way to find out otherwise was
 * to open the Quo app and notice.
 *
 * Two lists, deliberately separate, because they call for different things:
 *
 *   Didn't arrive   — one message, one customer, one thing to do about it.
 *   Closed numbers  — a standing fact about a phone. Nothing more will be
 *                     sent there until somebody says otherwise.
 *
 * Rolling them together would bury nine one-off failures under one landline,
 * or make a permanent fact look like nine separate problems.
 */
export default function Undelivered() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [failures, closed] = await Promise.all([
        fetchFailures(),
        fetchUnreachable(),
      ]);
      setRows(failures);
      setBlocked(closed);
      setError("");
    } catch (e) {
      console.error("Couldn't load undelivered texts:", e);
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

  async function reopen(phone) {
    setBusy(phone);
    try {
      await clearUnreachable(phone);
      await load();
    } catch (e) {
      console.error("Couldn't reopen that number:", e);
      setError(e?.message || "Couldn't reopen that number.");
    } finally {
      setBusy(null);
    }
  }

  // Where a row goes when you press it. The customer if there is one, the
  // lead otherwise — whichever record you'd act on.
  function open(row) {
    if (row.customer_id) navigate(`/customers/${row.customer_id}`);
    else if (row.lead_id) navigate(`/leads/${row.lead_id}`);
  }

  return (
    <div className="undel">
      <h1 className="visually-hidden">Texts that didn&rsquo;t arrive</h1>
      <ViewSwitcher views={CUSTOMER_VIEWS} section="customers" />

      {error && <p className="undel__error">{error}</p>}

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
                  onClick={() => reopen(b.phone)}
                  disabled={busy === b.phone}
                >
                  {busy === b.phone ? "Reopening…" : "Reopen"}
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
            Every text has reached the person it was sent to. Nothing to do
            here.
          </p>
        ) : (
          <ul className="undel__list">
            {rows.map((r) => (
              <li
                className={`undelrow undelrow--${r.status}`}
                key={r.id}
                onClick={() => open(r)}
                role={r.customer_id || r.lead_id ? "button" : undefined}
                tabIndex={r.customer_id || r.lead_id ? 0 : undefined}
              >
                <div className="undelrow__top">
                  <span className="undelrow__who">{r.who || "Unknown"}</span>
                  <span className={`undelrow__tag undelrow__tag--${r.status}`}>
                    {failureLabel(r)}
                  </span>
                  <span className="undelrow__when">{shortWhen(r.created_at)}</span>
                </div>

                <p className="undelrow__do">{whatToDo(r)}</p>

                <p className="undelrow__meta">
                  {r.kind} &middot;{" "}
                  <a
                    className="undelrow__phone"
                    href={`tel:${r.phone}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {formatPhone(r.phone)}
                  </a>
                  {/* The way to actually reach them, right here. A failed
                      text with an email on file is a two-second fix and a
                      page that makes you go and look it up is a page that
                      gets ignored. */}
                  {r.email && (
                    <>
                      {" "}
                      &middot;{" "}
                      <a
                        className="undelrow__email"
                        href={`mailto:${r.email}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.email}
                      </a>
                    </>
                  )}
                </p>

                {r.error && <p className="undelrow__carrier">Carrier: {r.error}</p>}
                {r.body && <p className="undelrow__body">{r.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
