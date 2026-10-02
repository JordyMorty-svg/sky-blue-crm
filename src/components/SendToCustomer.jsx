import { useEffect, useState } from "react";
import { fetchCustomers } from "../services/customerService";
import {
  sendFollowUpToCustomer,
  fetchStoppedNumbers,
  reviewRoute,
  reviewBlockedReason,
  textableNumber,
} from "../services/followUpService";
import { formatPhone } from "../services/leadService";
import "./SendToCustomer.css";

/**
 * Send a review request to one named customer, now.
 *
 * Two jobs in one control, which is why it exists at all:
 *
 *   1. The real one — a customer who was delighted, or whose follow-up you
 *      skipped and then thought better of.
 *   2. Testing. There is otherwise no way to see the email without waiting
 *      three days for the schedule, and "does this actually work" is a
 *      question you want answered before it runs unattended.
 *
 * Why a customer can't be asked is shown on their row rather than discovered
 * by pressing the button and reading an error. That state has to be legible
 * in the list, not a surprise.
 *
 * Missing addresses are COMMON — every customer imported through Add past
 * jobs has no email, and so does anyone booked over the phone. Those rows
 * were greyed out as "No email" until Oct 2026, which meant the people most
 * likely to be delighted by a doorstep job were the ones nobody could ask.
 * They now show as a text, because the review request sends one.
 */

// Enough to find someone by typing a few letters, few enough that the page
// doesn't render 400 rows before you've typed anything.
const SHOW_LIMIT = 40;

// How a customer would be asked, shown on their row.
//
// "No email" is no longer a reason to block anybody — it is a reason to send
// a text. The only blocks left are the two the database also refuses:
// unsubscribed, and no usable address or number at all. reviewRoute() is the
// shared mirror of sb_follow_up_channel; see followUpService.js.
function routeFor(c, stopped) {
  const via = reviewRoute(c, stopped);
  if (!via) {
    // A blocked row still shows whatever we hold for them. "Nothing on file"
    // over a customer whose number replied STOP is wrong in the way that
    // costs somebody five minutes: they go and type in an email address to
    // fix a problem that was never a missing contact detail.
    return {
      blocked: reviewBlockedReason(c, stopped),
      to: c.email?.trim() || (c.phone ? formatPhone(c.phone) : "nothing on file"),
    };
  }
  return via === "sms"
    ? { via, label: "Text", to: formatPhone(c.phone), raw: textableNumber(c.phone) }
    : { via, label: "Email", to: c.email, raw: c.email };
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Where this customer has got to, but NOT a reason to stop you.
//
// Neither of these blocks the button: "reviewed" suppresses the AUTOMATIC
// email, and a person deliberately choosing a name is the judgement that
// rule stands in for — they might be asking about a second property, or the
// tick might be wrong. Shown, not enforced.
//
// Ordered by finality. Reviewed is the end of the story, so it wins over
// "we asked" even though both are true of the same customer — otherwise
// every reviewer would also read as still-waiting.
function noteFor(c) {
  if (c.reviewed_at) {
    return {
      tone: "reviewed",
      text: "Reviewed",
      title: `Recorded ${shortDate(c.reviewed_at)}`,
    };
  }
  if (c.last_review_request_at) {
    return {
      tone: "sent",
      // Channel-neutral: last_review_request_at is stamped by
      // mark_follow_up_sent whichever way the message went, and a badge
      // saying "Email sent" over a customer we texted is a small lie that
      // costs somebody a minute of confusion.
      text: "Asked",
      // The date goes in the tooltip rather than the badge: the row already
      // carries a name and an address, and three pieces of text competing
      // for the same line is how a scannable list stops being scannable.
      title: `Review request sent ${shortDate(c.last_review_request_at)} — no review yet`,
    };
  }
  return null;
}

export default function SendToCustomer({ refreshKey = 0 }) {
  const [customers, setCustomers] = useState([]);
  // Numbers that have replied STOP. Fetched alongside the customers so a row
  // can say "Replied STOP" rather than offering a text the database refuses.
  const [stopped, setStopped] = useState(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);

  // Re-runs when refreshKey changes, which is how a batch send from the
  // panel above gets reflected here — that run stamps last_review_request_at
  // on several customers at once, and this list would otherwise keep showing
  // them as never-asked until the page was reloaded.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rows, stops] = await Promise.all([
          fetchCustomers(),
          fetchStoppedNumbers(),
        ]);
        if (!cancelled) {
          setCustomers(rows || []);
          setStopped(stops);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load customers.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function handleSend() {
    if (!picked) return;
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const res = await sendFollowUpToCustomer(picked.id);

      // Success is `sent > 0`, and nothing weaker.
      //
      // This used to be `failed === 0`, which is not the same thing and was
      // wrong in the one way that matters: a response of
      // { sent: 0, failed: 0 } — the server accepted the request and mailed
      // nobody — has no failures in it, so the CRM cheerfully said "Sent to
      // Jordan Mortensen" while the inbox stayed empty. A tool that reports
      // a send it didn't make is worse than one that errors, because you
      // stop looking.
      if (res.sent > 0) {
        // Patch the row in place rather than refetching. The send just
        // succeeded, and mark_follow_up_sent stamps now() — so this is the
        // same value the server holds, and the "Email sent" badge appears
        // the instant you look for it instead of after a reload.
        //
        // Only this field: re-reading the whole customer would also
        // overwrite anything else that changed while the page was open.
        const stampedAt = new Date().toISOString();
        setCustomers((cur) =>
          cur.map((c) =>
            c.id === picked.id ? { ...c, last_review_request_at: stampedAt } : c
          )
        );
        // From the server's own answer, not from what this page guessed.
        // The database picks the channel at send time with the real opt-out
        // tables in front of it, so `results[0]` is the only honest account
        // of where the message actually went.
        const went = res.results?.[0] || {};
        setDone({
          name: picked.name,
          to: went.to || picked.email || picked.phone,
          via: went.via || "email",
        });
        setPicked(null);
        setSearch("");
      } else if (res.failed > 0) {
        // Claimed, then the provider rejected it.
        setError(res.results?.[0]?.error || "It didn't send.");
      } else if (res.deferred > 0) {
        // Not a failure and not a send: texting is switched off, Quo isn't
        // configured, or it is outside 9am-8pm. The row is back in the queue
        // untouched, so say that rather than letting it read as an error.
        setError(
          res.results?.[0]?.deferred === "quiet_hours"
            ? "Not sent — it's outside texting hours (9am–8pm). It stays queued."
            : `Not sent — texting is currently ${
                res.results?.[0]?.deferred || "unavailable"
              }. It stays queued.`
        );
      } else {
        // Accepted, nothing sent, nothing failed. Nearly always a version
        // skew: an older deployed function that ignores customerId and runs
        // the batch instead, finding nothing due. Name the likely cause —
        // "nothing happened" on its own is impossible to act on.
        setError(
          "Nothing was sent. The request went through but no email went out — " +
            "check that db/follow-ups.sql has been re-run and that the deploy finished."
        );
      }
    } catch (e) {
      console.error(e);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Recomputed rather than stored with `picked`, so a STOP that lands
  // between picking and pressing is reflected on the next render.
  const pickedRoute = picked ? routeFor(picked, stopped) : null;

  const q = search.trim().toLowerCase();
  const matches = q
    ? customers.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.email || "").toLowerCase().includes(q) ||
          (c.phone || "").includes(q)
      )
    : customers;
  const shown = matches.slice(0, SHOW_LIMIT);

  if (loading) return <p className="stc__loading">Loading customers…</p>;

  return (
    <section className="stc">
      <div className="stc__head">
        <h2 className="stc__title">Send to one customer</h2>
        <p className="stc__blurb">
          Sends the review request straight away, without waiting for the
          three-day rule — for a customer you&rsquo;d like to ask now, or to
          test it against a customer of your own. Goes by email where we have
          one, by text where we don&rsquo;t.
        </p>
      </div>

      {error && <p className="stc__error">{error}</p>}

      {done && (
        <p className="stc__done">
          {done.via === "sms" ? "Texted" : "Emailed"} <strong>{done.name}</strong>{" "}
          {done.via === "sms" ? "on" : "at"}{" "}
          {done.via === "sms" ? formatPhone(done.to) : done.to}. It&rsquo;s on
          their history too.
        </p>
      )}

      {picked ? (
        <div className="stc__confirm">
          <div className="stc__confirmwho">
            <span className="stc__confirmname">{picked.name}</span>
            {/* The destination AND the route. "Send review request" over a
                bare name told you nothing about whether it was about to put
                a text on somebody's phone. */}
            <span className="stc__confirmmail">
              <span
                className={`stc__via stc__via--${pickedRoute.via}`}
              >
                {pickedRoute.label}
              </span>
              {pickedRoute.to}
            </span>
          </div>
          <div className="stc__confirmactions">
            <button
              type="button"
              className="stc__send"
              onClick={handleSend}
              disabled={busy}
            >
              {busy
                ? "Sending…"
                : pickedRoute.via === "sms"
                  ? "Text review request"
                  : "Email review request"}
            </button>
            <button
              type="button"
              className="stc__cancel"
              onClick={() => setPicked(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            className="stc__search"
            type="search"
            placeholder="Search by name, email, or phone…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setDone(null);
            }}
          />

          {shown.length === 0 ? (
            <p className="stc__empty">
              {q ? "Nobody matches that." : "No customers yet."}
            </p>
          ) : (
            <ul className="stc__list">
              {shown.map((c) => {
                const route = routeFor(c, stopped);
                const note = route.blocked ? null : noteFor(c);
                return (
                  <li className="stc__row" key={c.id}>
                    <button
                      type="button"
                      className="stc__pick"
                      disabled={!!route.blocked}
                      onClick={() => {
                        setPicked(c);
                        setDone(null);
                        setError("");
                      }}
                    >
                      <span className="stc__name">{c.name || "Unnamed"}</span>
                      <span className="stc__mail">
                        {route.blocked ? (
                          route.to
                        ) : (
                          <>
                            <span className={`stc__via stc__via--${route.via}`}>
                              {route.label}
                            </span>
                            {route.to}
                          </>
                        )}
                      </span>
                      {route.blocked && (
                        <span className="stc__blocked">{route.blocked}</span>
                      )}
                      {note && (
                        <span
                          className={`stc__note stc__note--${note.tone}`}
                          title={note.title}
                        >
                          {note.text}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {matches.length > shown.length && (
            <p className="stc__more">
              {matches.length - shown.length} more — keep typing to narrow it
              down.
            </p>
          )}
        </>
      )}
    </section>
  );
}
