import { useState } from "react";
import {
  previewFollowUps,
  sendFollowUpsNow,
} from "../services/followUpService";
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
 */
export default function FollowUpRunner() {
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
      setResult({ kind: "send", ...(await sendFollowUpsNow()) });
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
        <h2 className="fuprun__title">Follow-up emails</h2>
        <p className="fuprun__blurb">
          Three days after a job is completed, the customer gets one thank-you
          and review request. It runs itself each morning — this is for
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
              {would.length} {would.length === 1 ? "email" : "emails"} would go
              out. Nothing has been sent.
            </p>
            <ul className="fuprun__list">
              {would.map((r, i) => (
                <li className="fuprun__row" key={`${r.to}-${i}`}>
                  <span className="fuprun__who">{r.name || "Unnamed"}</span>
                  <span className="fuprun__addr">{r.to}</span>
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {result?.kind === "send" && (
        <p className="fuprun__count">
          {result.sent === 0 && result.failed === 0
            ? "Nothing was due — no emails sent."
            : `Sent ${result.sent}.`}
          {result.failed > 0 && ` ${result.failed} failed and will retry.`}
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
