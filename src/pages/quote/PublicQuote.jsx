import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { SERVICE_LABELS, money } from "../../services/quoteService";
import "./PublicQuote.css";

/**
 * The page a customer lands on. The only page in this app seen by someone
 * who isn't logged in.
 *
 * Constraints that shaped it:
 *
 *   * No Supabase client. Everything goes through /api/quote/:token, so the
 *     anon key is never handed to a stranger's browser and `quotes` stays
 *     staff-only in the database.
 *   * No app chrome. No nav, no "Sky Blue CRM", no sign-out button. This is
 *     a customer-facing page that happens to live at the same domain; it
 *     should read like a quote, not like software.
 *   * Every dead end explains itself. Expired, already accepted, bad link —
 *     each says what happened and how to reach a human, because the person
 *     reading it cannot open a ticket.
 */

export default function PublicQuote() {
  const { token } = useParams();
  const [quote, setQuote] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | missing | error
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/quote/${token}`);
      if (res.status === 404) {
        setState("missing");
        return;
      }
      if (!res.ok) throw new Error("lookup failed");
      const data = await res.json();
      setQuote(data.quote);
      setAccepted(data.quote.status === "accepted");
      setState("ready");
    } catch (e) {
      console.error(e);
      setState("error");
    }
  }, [token]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function accept() {
    setAccepting(true);
    setProblem("");
    try {
      const res = await fetch(`/api/quote/${token}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));

      if (data.ok) {
        setAccepted(true);
        return;
      }

      // The server answers with a reason rather than a status code, because
      // "expired" is an outcome the customer needs explained, not an error.
      setProblem(
        {
          expired: "This quote has expired — but give us a call and we'll sort it out.",
          declined: "This quote was already turned down. Call us if that was a mistake.",
          not_found: "We couldn't find this quote. Check the link, or give us a call.",
        }[data.reason] || "Something went wrong. Give us a call and we'll take care of it."
      );
    } catch (e) {
      console.error(e);
      setProblem("Couldn't reach us just now — check your signal and try again.");
    } finally {
      setAccepting(false);
    }
  }

  if (state === "loading") {
    return <div className="pq__state">Loading your quote…</div>;
  }

  if (state === "missing" || state === "error") {
    return (
      <div className="pq">
        <div className="pq__card">
          <Brand />
          <div className="pq__body">
            <h1 className="pq__h1">We couldn&rsquo;t find that quote</h1>
            <p className="pq__p">
              The link may have expired or been mistyped. Give us a call and
              we&rsquo;ll get you a new one straight away.
            </p>
            <Contact />
          </div>
        </div>
      </div>
    );
  }

  const expired = quote.expired && !accepted;
  const services = (quote.service_keys?.length
    ? quote.service_keys
    : ["residential-window-washing"]
  ).map((k) => SERVICE_LABELS[k] || k);

  return (
    <div className="pq">
      <div className="pq__card">
        <Brand />

        <div className="pq__body">
          {accepted ? (
            <>
              <div className="pq__tick" aria-hidden="true">✓</div>
              <h1 className="pq__h1">You&rsquo;re booked</h1>
              <p className="pq__p">
                Thanks {firstName(quote.customer_name)} — we&rsquo;ve got it.
                We&rsquo;ll be in touch shortly to agree a day that works for
                you. Nothing to pay until the job&rsquo;s done.
              </p>
            </>
          ) : (
            <>
              <h1 className="pq__h1">
                Your quote{quote.customer_name ? `, ${firstName(quote.customer_name)}` : ""}
              </h1>

              {quote.address && <p className="pq__addr">{quote.address}</p>}

              <div className="pq__amount">{money(quote.amount)}</div>

              <ul className="pq__services">
                {services.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>

              <p className="pq__included">
                Every job includes the screens scrubbed and rinsed, plus the
                sills and tracks wiped down.
              </p>

              {quote.note && <p className="pq__note">{quote.note}</p>}

              {expired ? (
                <>
                  <p className="pq__expired">
                    This quote has expired. Give us a call and we&rsquo;ll
                    put a fresh one together — prices usually haven&rsquo;t
                    moved.
                  </p>
                  <Contact />
                </>
              ) : (
                <>
                  <button
                    className="pq__accept"
                    onClick={accept}
                    disabled={accepting}
                  >
                    {accepting ? "One moment…" : "Accept this quote"}
                  </button>
                  <p className="pq__fine">
                    No deposit. No payment until the work is finished.
                  </p>
                  {problem && <p className="pq__problem">{problem}</p>}
                </>
              )}
            </>
          )}

          {(accepted || !expired) && <Contact quiet={!accepted} />}
        </div>
      </div>

      <p className="pq__foot">Sky Blue Cleaning Co. · Corvallis, Oregon</p>
    </div>
  );
}

function firstName(full) {
  return String(full || "").trim().split(/\s+/)[0] || "";
}

function Brand() {
  return (
    <div className="pq__brand">
      <span className="pq__brandname">
        Sky Blue <span className="pq__brandaccent">Cleaning Co.</span>
      </span>
    </div>
  );
}

// Phone first and tappable. Someone reading this on a phone who has a
// question wants to call, not compose an email.
function Contact({ quiet = false }) {
  return (
    <p className={`pq__contact ${quiet ? "pq__contact--quiet" : ""}`}>
      Questions? <a className="pq__tel" href="tel:15417303593">(541) 730-3593</a>
      <span className="pq__sep">·</span>
      <a href="mailto:company@skybluecleaningco.com">
        company@skybluecleaningco.com
      </a>
    </p>
  );
}
