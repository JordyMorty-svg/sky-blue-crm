import { useState } from "react";
import {
  previewFollowUps,
  sendFollowUpsNow,
} from "../services/followUpService";
import { formatPhone } from "../services/leadService";
import "./FollowUpRunner.css";

/**
 * "Who is about to get a review request?"
 *
 * The daily send runs on a schedule inside Netlify, which means the only
 * evidence it exists is in function logs nobody is going to read. This is
 * the window into it: check what is queued, and send by hand if you want to
 * without waiting for tomorrow morning.
 *
 * Preview is the point. It answers the question by asking the database what
 * it WOULD do, rather than the traditional method of running the real thing
 * and watching what lands in customers' inboxes.
 *
 * Each row carries `via` — email or text — because since Oct 2026 some of
 * these are texts, and a preview that showed every row the same way would
 * quietly hide the half of it that costs money and lands on a phone.
 */
// "3 emails and 1 text would go out." Counting them separately because the
// two are not the same thing to the person reading it: one is free and lands
// in a folder nobody checks, the other costs per segment and buzzes in
// somebody's pocket.
function describeQueue(rows) {
  const texts = rows.filter((r) => r.via === "sms").length;
  const emails = rows.length - texts;
  const parts = [];
  if (emails) parts.push(`${emails} ${emails === 1 ? "email" : "emails"}`);
  if (texts) parts.push(`${texts} ${texts === 1 ? "text" : "texts"}`);
  return `${parts.join(" and ")} would go out.`;
}

// Why the deferred ones are waiting, in the words the sender used.
function deferReason(results = []) {
  const why = results.find((r) => r.deferred)?.deferred;
  if (why === "quiet_hours") return "it's outside texting hours (9am\u20138pm)";
  if (why === "sms_off" || why === "preview") return "SMS_MODE isn't set to send";
  if (why === "not_configured" || why === "no_sms_tables")
    return "texting isn't set up yet";
  return "they'll go on the next run";
}

export default function FollowUpRunner({ onSent }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  async function handlePreview() {
    setBusy("preview");
    setError("");
    setConfirming(false);
    try {
      setResult({ kind: "preview", ...(await previewFollowUps()) });
    } catch (e) {
      console.error(e);
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function handleSend() {
    setBusy("send");
    setError("");
    setConfirming(false);
    try {
      const res = await sendFollowUpsNow();
      setResult({ kind: "send", ...res });
      // Only when something actually went out. A run that found nothing due
      // changed no customer, and making the sibling list refetch for that
      // would be a round trip to redraw the same thing.
      if (res.sent > 0) onSent?.();
    } catch (e) {
      console.error(e);
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const would = result?.would_send || [];

  return (
    <section className="fuprun">
      <div className="fuprun__head">
        <h2 className="fuprun__title">Review requests</h2>
        <p className="fuprun__blurb">
          Three days after a job is completed, the customer gets one thank-you
          and review request — by email where we have an address, by text
          where we don&rsquo;t. It runs itself each morning; this is for
          checking what&rsquo;s queued, or sending early.
        </p>
      </div>

      <div className="fuprun__actions">
        <button
          type="button"
          className="fuprun__btn"
          onClick={handlePreview}
          disabled={!!busy}
        >
          {busy === "preview" ? "Checking…" : "Who's due?"}
        </button>

        {/* Two taps to send, because the second one puts real email in front
            of real customers and there is no recall. */}
        {confirming ? (
          <>
            <button
              type="button"
              className="fuprun__btn fuprun__btn--danger"
              onClick={handleSend}
              disabled={!!busy}
            >
              {busy === "send" ? "Sending…" : "Yes, send them now"}
            </button>
            <button
              type="button"
              className="fuprun__btn"
              onClick={() => setConfirming(false)}
              disabled={!!busy}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="fuprun__btn"
            onClick={() => setConfirming(true)}
            disabled={!!busy}
          >
            Send now
          </button>
        )}
      </div>

      {error && <p className="fuprun__error">{error}</p>}

      {result?.kind === "preview" && (
        would.length === 0 ? (
          <p className="fuprun__none">
            Nothing due right now. A job completed today comes due in three
            days, so an empty list here is the normal state most of the time.
          </p>
        ) : (
          <>
            <p className="fuprun__count">
              {describeQueue(would)} Nothing has been sent.
            </p>
            <ul className="fuprun__list">
              {would.map((r, i) => (
                <li className="fuprun__row" key={`${r.to}-${i}`}>
                  <span className="fuprun__who">{r.name || "Unnamed"}</span>
                  <span className={`fuprun__via fuprun__via--${r.via || "email"}`}>
                    {r.via === "sms" ? "Text" : "Email"}
                  </span>
                  <span className="fuprun__addr">
                    {r.via === "sms" ? formatPhone(r.to) : r.to}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {result?.kind === "send" && (
        <p className="fuprun__count">
          {result.sent === 0 && result.failed === 0 && !result.deferred
            ? "Nothing was due — nothing sent."
            : `Sent ${result.sent}.`}
          {result.failed > 0 && ` ${result.failed} failed and will retry.`}
          {/* Deferred is neither. It means texting is off, or it is outside
              9am-8pm — the rows went back in the queue with their attempts
              intact. Reported separately because reading it as a failure
              would send somebody looking for a problem that isn't one. */}
          {result.deferred > 0 &&
            ` ${result.deferred} ${
              result.deferred === 1 ? "text is" : "texts are"
            } waiting — ${deferReason(result.results)}.`}
          {result.swept > 0 &&
            ` ${result.swept} stale ${
              result.swept === 1 ? "one was" : "ones were"
            } closed out.`}
        </p>
      )}

      {/* configured_mode, not mode: `mode` is what the run you just triggered
          did, which is always preview or send because you pressed a button.
          What matters here is what tomorrow morning will do on its own, and
          that comes from the environment. Read from the server rather than
          guessed, so this can't claim the automation is live when Netlify
          says otherwise. */}
      {result && result.configured_mode !== "send" && (
        <p className="fuprun__off">
          Heads up: the daily send is <strong>off</strong>.{" "}
          <code>FOLLOW_UPS_MODE</code> is{" "}
          <code>{result.configured_mode || "unset"}</code> in Netlify, so
          nothing goes out on its own. Sending by hand still works.
        </p>
      )}
    </section>
  );
}
