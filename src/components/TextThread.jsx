import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeMessage,
  fetchThread,
  prettyPhone,
  segmentsFor,
  sendText,
} from "../services/textService";
import "./TextThread.css";

/**
 * The text conversation with one person, and a box to add to it.
 *
 * One component for the lead page and the customer page, the same way
 * QuotesPanel is one component for both: the two records differ only in
 * which id a new message gets stamped with, and the conversation itself is
 * the same conversation. See db/sms-thread.sql — the thread is keyed on the
 * PHONE NUMBER, because one person is routinely two leads and a customer
 * and the thread on their handset is not three threads.
 *
 * WHAT THIS REPLACES. Until now, reading a conversation meant picking up a
 * phone, opening Quo, and finding the number — while the CRM, which knew who
 * they were and what you had quoted them, showed nothing. Both halves of the
 * conversation have been in sms_messages the whole time; there was simply
 * nothing that asked for them.
 */
export default function TextThread({
  phone,
  leadId = null,
  customerId = null,
  // Sending a text writes a contact_log row, which the history panel on the
  // same page is showing. Without this the two disagree until a reload.
  onSent,
  // Collapsed by default on the customer page, which already has quotes,
  // jobs and history stacked up. The lead page has room.
  startOpen = true,
}) {
  const [open, setOpen] = useState(startOpen);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Separate from loadError on purpose. "We couldn't load the thread" and
  // "that number replied STOP" are different problems with different
  // answers, and one slot for both means the second overwrites the first.
  const [sendError, setSendError] = useState("");

  const scroller = useRef(null);

  const load = useCallback(async () => {
    if (!phone) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setLoadError("");
      const data = await fetchThread(phone);
      setRows(data);
    } catch (e) {
      console.error(e);
      setLoadError(
        // Named, because it has a one-line fix and is otherwise a mystery.
        /sms_thread/i.test(String(e?.message))
          ? "Run db/sms-thread.sql in Supabase — the thread query isn't installed yet."
          : "Couldn't load the conversation."
      );
    } finally {
      setLoading(false);
    }
  }, [phone]);

  // load() is a useCallback over `phone`, so this re-runs when the number
  // on the page changes — which it does, because the phone field on both
  // pages is editable and somebody fixing a typo should see that person's
  // thread, not the one belonging to the number they just corrected.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Pin to the newest message, the way every messaging app does. Runs on
  // every change to the list rather than only on load, so a message you just
  // sent is the one you are looking at.
  useEffect(() => {
    const el = scroller.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [rows, open]);

  async function handleSend(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setSendError("");
    try {
      const result = await sendText({ phone, body, leadId, customerId });

      if (!result.ok) {
        // A refusal the CRM understands — opted out, texting switched off.
        // The draft is DELIBERATELY not cleared: the message was not sent,
        // and throwing away what somebody typed because the system said no
        // is how you lose a paragraph they will not retype.
        setSendError(result.error || "That text didn't go out.");
        return;
      }

      setDraft("");
      await load();
      onSent?.();
    } catch (e) {
      console.error(e);
      setSendError(
        e?.message ||
          "Couldn't reach the server. The text may or may not have gone — check Quo before resending."
      );
    } finally {
      setSending(false);
    }
  }

  // Enter sends, Shift+Enter makes a new line. The same way every messaging
  // app anyone uses already works, so nobody has to be told.
  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  }

  if (!phone) {
    return (
      <section className="thread">
        <h3 className="thread__title">Texts</h3>
        <p className="thread__empty">No phone number on file, so there's nothing to text.</p>
      </section>
    );
  }

  const count = segmentsFor(draft).segments;

  return (
    <section className="thread">
      <div className="thread__head">
        <h3 className="thread__title">Texts</h3>
        <span className="thread__number">{prettyPhone(phone)}</span>
        <button
          type="button"
          className="thread__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Hide" : `Show${rows.length ? ` (${rows.length})` : ""}`}
        </button>
      </div>

      {open && (
        <>
          {loadError && <p className="thread__error">{loadError}</p>}

          <div className="thread__scroll" ref={scroller}>
            {loading ? (
              <p className="thread__empty">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="thread__empty">
                No texts with this number yet. Anything sent from here or from
                the Quo app will show up.
              </p>
            ) : (
              rows.map((row) => <Bubble key={row.id} row={row} />)
            )}
          </div>

          <form className="thread__compose" onSubmit={handleSend}>
            <textarea
              className="thread__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write a text…"
              rows={2}
              disabled={sending}
            />
            <div className="thread__actions">
              <span className="thread__count">
                {draft.trim()
                  ? /* Only once it matters. "1 message" under an empty box is
                       noise; "2 messages" under a long one is the moment
                       somebody decides to shorten it. */
                    count > 1
                    ? `${count} messages · ${draft.length} characters`
                    : `${draft.length} characters`
                  : ""}
              </span>
              <button
                type="submit"
                className="thread__send"
                disabled={!draft.trim() || sending}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
            {sendError && <p className="thread__error">{sendError}</p>}
          </form>
        </>
      )}
    </section>
  );
}

function Bubble({ row }) {
  const { mine, who, automatic, state } = describeMessage(row);

  return (
    <div className={`thread__row ${mine ? "thread__row--mine" : "thread__row--theirs"}`}>
      <div
        className={`thread__bubble${automatic ? " thread__bubble--auto" : ""}${
          state?.tone === "bad" ? " thread__bubble--failed" : ""
        }`}
      >
        <p className="thread__body">{row.body}</p>
      </div>
      <p className="thread__meta">
        <span className="thread__who">{who}</span>
        <span className="thread__at">{stamp(row.created_at)}</span>
        {state && (
          <span className={`thread__state thread__state--${state.tone}`}>
            {state.label}
          </span>
        )}
        {/* The carrier's own words, when there are any. "Not delivered" on
            its own invites a resend to a landline that will never accept
            one; "Not delivered — unreachable carrier" does not. */}
        {state?.detail && <span className="thread__why">{state.detail}</span>}
      </p>
    </div>
  );
}

/**
 * Today shows a time, this year shows a date and a time, older shows the
 * year as well.
 *
 * NO UTC ANYWHERE. A timestamptz comes out of Supabase as an ISO string with
 * an offset, and `new Date(iso).toLocaleString()` renders it in the reader's
 * own timezone, which is the one they are standing in.
 */
function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();

  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  if (d.toDateString() === now.toDateString()) return time;

  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}
