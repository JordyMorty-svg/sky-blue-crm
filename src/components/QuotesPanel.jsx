import { useCallback, useEffect, useState } from "react";
import QuoteModal from "./QuoteModal";
import {
  SERVICE_LABELS,
  deletable,
  deleteQuote,
  closeQuote,
  reopenQuote,
  CLOSE_REASONS,
  closeReason,
  reopenable,
  describeLoadError,
  fetchQuotes,
  money,
  quoteState,
  shortDate,
  smsHref,
  viewSummary,
  smsText,
} from "../services/quoteService";
import {
  fetchQuoteDelivery,
  failureLabel,
  whatToDo,
} from "../services/deliveryService";
import "./QuotesPanel.css";

/**
 * Quotes for one lead or one customer: the button that sends a new one, and
 * the list of every one already sent.
 *
 * One component for both pages rather than two copies. The two records differ
 * only in which id the quote hangs off — everything downstream (who it's for,
 * what it costs, whether they opened it) is identical, and a list that drifts
 * between Leads and Customers is a list people stop trusting.
 *
 * The list is not decoration. "Did we already quote them?" is the question
 * asked before every follow-up, and the answer used to live in someone's
 * memory of a text thread.
 */
export default function QuotesPanel({
  leadId = null,
  customerId = null,
  customerName,
  customerEmail = null,
  customerPhone = null,
  address = null,
  suggestedAmount = null,
  suggestedServices = null,
  // The customer's jobs, for "which job was it done on?" when a quote is
  // closed because the work happened elsewhere. Defaulted to empty and the
  // picker simply does not render without them, so a caller that hasn't got
  // them degrades to closing with a reason and no link rather than breaking.
  jobs = [],
  // Leads move to Booked when a quote is accepted, so the page behind this
  // needs a chance to re-read itself.
  onChanged,
  // The customer page moved every action into one menu, so its "Send a quote"
  // lives there rather than here. The panel keeps its own button by default,
  // because the lead page still shows one.
  showSendButton = true,
  // Run before the quote modal opens. Returns nothing on success and THROWS
  // on failure, which is what stops the modal opening on a failed save.
  //
  // It exists because of a trap on the lead page: "Save changes" there saves
  // AND navigates back to the board, so there was no way to save the edits
  // you had just made and then send a quote from the same screen. Hayden
  // typed changes, pressed Send a quote, and the lead record kept the old
  // values — the quote itself was fine, because the modal reads the form
  // rather than the saved row, but everything he had typed was lost the
  // moment he left the page.
  beforeSend = null,
  // Optionally controlled, for exactly that case: the menu is outside this
  // component, so something outside has to be able to open the modal. Left
  // alone, the panel manages its own state as before.
  open: openProp,
  onOpenChange,
}) {
  const [quotes, setQuotes] = useState([]);
  const [delivery, setDelivery] = useState({});
  const [selfOpen, setSelfOpen] = useState(false);
  const [loadError, setLoadError] = useState("");

  const controlled = typeof openProp === "boolean";
  const open = controlled ? openProp : selfOpen;
  const setOpen = controlled ? (v) => onOpenChange?.(v) : setSelfOpen;
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState("");

  /**
   * Save first, then open.
   *
   * In that order, and the modal does NOT open if the save fails. Opening it
   * anyway would send a quote off a page whose edits are about to be lost,
   * which is the bug this is here to fix, only quieter.
   */
  async function openSend() {
    if (!beforeSend) {
      setOpen(true);
      return;
    }
    setPreparing(true);
    setPrepError("");
    try {
      await beforeSend();
      setOpen(true);
    } catch (e) {
      console.error("Couldn't save before sending the quote:", e);
      setPrepError(
        e?.message || "Couldn't save your changes, so the quote wasn't started."
      );
    } finally {
      setPreparing(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const rows = await fetchQuotes({ leadId, customerId });
      setQuotes(rows);
      // Second query rather than a join, because it must not be able to stop
      // the quotes rendering. A panel that says "couldn't load quotes"
      // because a delivery lookup failed is worse than one with no badges:
      // an empty quote list is the one wrong answer that makes somebody send
      // a second quote at a different price.
      setDelivery(await fetchQuoteDelivery(rows.map((q) => q.id)));
      setLoadError("");
    } catch (e) {
      console.error("Couldn't load quotes:", e);
      // Says so rather than rendering an empty list. An empty list here reads
      // as "we never quoted them", which is the one wrong answer that makes
      // someone send a second quote at a different price.
      //
      // And it says WHY. "Couldn't load past quotes" on every customer at
      // once sent somebody looking through DevTools for a message the code
      // already had in its hand. Everyone who can see this screen is signed
      // in, so there is nothing to protect by hiding it.
      setLoadError(describeLoadError(e));
    }
  }, [leadId, customerId]);

  // Started inside the effect rather than called directly, so the state
  // updates land after the await instead of synchronously during the effect
  // (react-hooks/set-state-in-effect) — the same shape LeadDetail uses.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleSent() {
    await load();
    onChanged?.();
  }

  // Still outstanding: sent or opened, not expired, not answered either way.
  const live = quotes.filter((q) => {
    const key = quoteState(q).key;
    return key === "sent" || key === "viewed";
  });

  return (
    <div className="quotes">
      <div className="quotes__head">
        <h2 className="quotes__title">Quotes</h2>
        {showSendButton && (
          <button
            className="quotes__send"
            onClick={openSend}
            disabled={preparing}
          >
            {preparing
              ? "Saving…"
              : quotes.length
                ? "Send another quote"
                : "Send a quote"}
          </button>
        )}
      </div>

      {loadError && <p className="quotes__error">{loadError}</p>}

      {quotes.length === 0 && !loadError && (
        <p className="quotes__empty">
          No quotes sent yet. They get a page with the price and one button;
          accepting it books the job here automatically.
        </p>
      )}

      {live.length > 1 && (
        <p className="quotes__warn">
          {live.length} quotes are still live for this person. Whichever they
          accept is the one that books.
        </p>
      )}

      {quotes.length > 0 && (
        <ul className="quotes__list">
          {quotes.map((q) => (
            <QuoteRow
              jobs={jobs}
              undelivered={delivery[q.id]}
              key={q.id}
              quote={q}
              customerName={customerName}
              customerPhone={customerPhone}
              onDeleted={load}
            />
          ))}
        </ul>
      )}

      {prepError && <p className="quotes__preperr">{prepError}</p>}

      {open && (
        <QuoteModal
          leadId={leadId}
          customerId={customerId}
          customerName={customerName}
          customerEmail={customerEmail}
          customerPhone={customerPhone}
          address={address}
          suggestedAmount={suggestedAmount}
          suggestedServices={suggestedServices}
          onClose={() => setOpen(false)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}

function QuoteRow({
  quote,
  jobs = [],
  customerName,
  customerPhone,
  undelivered = null,
  onDeleted,
}) {
  const state = quoteState(quote);
  const [copied, setCopied] = useState(false);
  // Three states, not two: idle, asking, deleting. A single confirm() would
  // have been less code and is a modal that blocks the whole tab — and the
  // one thing worse than an accidental delete is a confirm box somebody
  // dismisses by reflex.
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [closing, setClosing] = useState(false);
  // Three states, like delete: idle, picking a reason, saving. The prompt is
  // the feature — "Closed" with no why throws away the only interesting
  // thing about a quote that ended.
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState("");
  const [closeJob, setCloseJob] = useState("");

  const canDelete = deletable(quote);
  // Same rule as delete, same reason: an accepted quote has a job and a
  // booking fee hanging off it. Read from the shared helper rather than
  // re-tested here, so the two controls can never come to disagree about
  // which quotes are untouchable.
  const isClosed = state.key === "closed";
  const canClose = canDelete.ok && !isClosed;
  const ending = closeReason(quote.closed_reason);
  const canReopen = reopenable(quote);
  const chosen = closeReason(reason);

  async function remove() {
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteQuote(quote.id);
      setAsking(false);
      // Reload rather than splice it out of local state. The panel shows
      // "N quotes are still live for this person", which is computed from
      // the list — dropping a row locally would leave that sentence counting
      // a quote that no longer exists.
      await onDeleted?.();
    } catch (e) {
      console.error("Couldn't delete that quote:", e);
      // The database writes this sentence for the person reading it — see
      // delete_quote() in db/delivery-controls.sql — so it is shown as-is
      // rather than replaced with something generic.
      setDeleteError(e?.message || "Couldn't delete that quote.");
      setDeleting(false);
    }
  }

  async function close() {
    if (!reason) return;
    setClosing(true);
    setDeleteError("");
    try {
      await closeQuote(quote.id, reason, {
        jobId: chosen?.asksForJob && closeJob ? closeJob : null,
      });
      setPicking(false);
      await onDeleted?.();
    } catch (e) {
      console.error("Couldn't close that quote:", e);
      // The database writes this sentence for whoever pressed the button.
      setDeleteError(e?.message || "Couldn't close that quote.");
    } finally {
      setClosing(false);
    }
  }

  async function reopen() {
    setClosing(true);
    setDeleteError("");
    try {
      await reopenQuote(quote.id);
      await onDeleted?.();
    } catch (e) {
      console.error("Couldn't reopen that quote:", e);
      setDeleteError(e?.message || "Couldn't reopen that quote.");
    } finally {
      setClosing(false);
    }
  }

  // A closed quote offers none of these. Texting somebody a link that now
  // refuses to be accepted is worse than sending nothing: they open it,
  // read "no longer available", and have to work out whether that is a
  // mistake or a message.
  const resendable =
    !isClosed &&
    (state.key === "sent" || state.key === "viewed" || state.key === "draft");
  // Built here rather than stored, so a quote sent before the domain moved
  // still produces a link on today's domain.
  const link = `${window.location.origin}/q/${quote.token}`;

  const views = viewSummary(quote);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const services = (quote.service_keys || [])
    .map((k) => SERVICE_LABELS[k] || k)
    .join(" · ");

  return (
    <li className="quoterow">
      <div className="quoterow__main">
        <span className="quoterow__amount">{money(quote.amount)}</span>
        <span className={`quoterow__state quoterow__state--${state.tone}`}>
          {state.label}
        </span>
      </div>

      {services && <p className="quoterow__services">{services}</p>}

      {/* Above the meta line, not inside it. "Sent 22 Sep" and "the text
          never arrived" are contradictory facts and burying the second one
          in the small print under the first is how somebody reads the row,
          believes the quote landed, and waits for a reply that is never
          coming. */}
      {undelivered && (
        <p className="quoterow__undelivered">
          <strong>{failureLabel(undelivered)}</strong> — {whatToDo(undelivered)}
          {undelivered.error && (
            <span className="quoterow__carrier">
              {" "}
              {/* Whose words these are. "Carrier said" on a bounced email is
                  a small lie that sends somebody to the phone company about
                  a mail server. */}
              {undelivered.channel === "email" ? "Mail server" : "Carrier"} said:{" "}
              {undelivered.error}.
            </span>
          )}
        </p>
      )}

      <p className="quoterow__meta">
        Sent {shortDate(quote.sent_at || quote.created_at)}
        {quote.sender?.full_name ? ` by ${quote.sender.full_name}` : ""}
        {/* In the meta line rather than the badge. The badge is the status
            and should stay the same width from row to row; how many times
            they came back is detail, and detail belongs here. */}
        {views && <span className="quoterow__views"> · {views}</span>}
        {quote.accepted_at ? ` · accepted ${shortDate(quote.accepted_at)}` : ""}
        {/* Said out loud. A quote appearing on a customer's profile that was
            never sent from it looks like a duplicate of one somebody already
            sent, and the natural reaction is to check — or worse, to send
            another. One clause turns it from a puzzle into a fact. */}
        {quote.from_elsewhere && (
          <span className="quoterow__origin">
            {quote.lead_id ? " · sent while they were a lead" : " · sent from their customer record"}
          </span>
        )}
      </p>

      {resendable && (
        <div className="quoterow__actions">
          {customerPhone && (
            <a
              className="quoterow__btn"
              href={smsHref(
                customerPhone,
                smsText({
                  customerName,
                  amount: quote.amount,
                  link,
                  // WHO SENT THE QUOTE, not who is holding the phone.
                  //
                  // Re-texting a link for a quote Jordan sent should still
                  // say Jordan — the customer already has one message from
                  // him about this exact number, and a second introducing
                  // somebody else reads like they have been handed on.
                  // Same rule the email fallback follows in
                  // netlify/lib/anotherWay.mjs.
                  sentByName: quote.sender?.full_name || null,
                })
              )}
            >
              Text the link
            </a>
          )}
          <button className="quoterow__btn" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
          {/* There was deliberately no Preview button here for a long time,
              because opening the quote page is what flips `sent` to `viewed`
              and the database cannot tell a curious rep from the customer.
              That reasoning was right, but the fix was in the wrong place:
              Copy link hands out the same URL, and pasting it did the same
              damage with no warning at all.

              /api/quote/:token now identifies the caller from their session
              token server-side and only records a view for a request it
              positively identifies as NOT staff. Looking is safe, so the
              honest thing is to offer it rather than leave everyone pasting
              links into a browser to see the same page. */}
          <a
            className="quoterow__btn"
            href={`/q/${quote.token}`}
            target="_blank"
            // noreferrer alongside noopener: the target is our own origin, so
            // this is about not leaking which CRM record was open, not about
            // window.opener.
            rel="noopener noreferrer"
          >
            Preview
          </a>
        </div>
      )}

      {/* Delete sits in its own row, below the actions, and is rendered for
          EVERY quote rather than only the resendable ones — a declined quote
          and a stack of test quotes are exactly what somebody wants to clear,
          and those are the two states with no other buttons at all.

          Quiet by default and destructive-looking only once it has been
          asked. A red button sitting permanently next to "Copy link" is one
          slip away from deleting a live quote. */}
      <div className="quoterow__danger">
        {deleteError && <p className="quoterow__deleteerr">{deleteError}</p>}

        {/* Close sits ABOVE delete and is styled as the ordinary option,
            because it almost always is. "We quoted this and it went nowhere"
            is the common ending for a quote, and the record of having quoted
            it is worth keeping — it is how you know what you offered this
            person and for how much. Delete is for test rows and mistakes. */}
        {isClosed ? (
          <p className="quoterow__closed">
            <strong>{ending?.label || "Closed"}</strong>
            {quote.closed_note ? ` — ${quote.closed_note}` : ""}. The link no
            longer accepts.{" "}
            {canReopen ? (
              <button
                className="quoterow__reopen"
                onClick={reopen}
                disabled={closing}
              >
                {closing ? "Reopening…" : "Reopen it"}
              </button>
            ) : (
              /* No Reopen at all for an ending that is final. A disabled
                 button would invite the question; the sentence answers it. */
              <span className="quoterow__settled">
                Settled — send a new quote rather than reopening this one.
              </span>
            )}
          </p>
        ) : picking ? (
          <div className="quoterow__closing">
            <p className="quoterow__closingq">How did this quote end?</p>

            {CLOSE_REASONS.map((r) => (
              <label key={r.key} className="quoterow__reason">
                <input
                  type="radio"
                  name={`close-${quote.id}`}
                  value={r.key}
                  checked={reason === r.key}
                  onChange={() => {
                    setReason(r.key);
                    setCloseJob("");
                  }}
                />
                <span>
                  <strong>{r.label}</strong>
                  <span className="quoterow__reasonblurb">{r.blurb}</span>
                </span>
              </label>
            ))}

            {/* Only for the ending that means a job exists. Offering it
                beside "never heard back" would invite rows that say the work
                was done and not done at once — which the database refuses
                anyway, but an error is a worse way to learn it than an
                absent control. */}
            {chosen?.asksForJob && jobs.length > 0 && (
              <select
                className="quoterow__jobpick"
                value={closeJob}
                onChange={(e) => setCloseJob(e.target.value)}
                aria-label="Which job was it done on?"
              >
                <option value="">Which job? (optional)</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {shortDate(j.starts_at || j.created_at)} ·{" "}
                    {money(j.final_price ?? j.price)}
                  </option>
                ))}
              </select>
            )}

            <span className="quoterow__confirm">
              <button
                className="quoterow__btn quoterow__btn--go"
                onClick={close}
                disabled={closing || !reason}
              >
                {closing ? "Closing…" : "Close it"}
              </button>
              <button
                className="quoterow__btn"
                onClick={() => {
                  setPicking(false);
                  setReason("");
                  setCloseJob("");
                  setDeleteError("");
                }}
                disabled={closing}
              >
                Cancel
              </button>
            </span>
          </div>
        ) : canClose ? (
          <button className="quoterow__close" onClick={() => setPicking(true)}>
            Close this quote
          </button>
        ) : null}

        {!canDelete.ok ? (
          // Shown, not hidden. A missing button is a puzzle; a disabled one
          // with the reason under it is an answer.
          <p className="quoterow__nodelete">{canDelete.why}</p>
        ) : asking ? (
          <span className="quoterow__confirm">
            <span className="quoterow__confirmtext">Delete this quote?</span>
            <button
              className="quoterow__btn quoterow__btn--danger"
              onClick={remove}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
            <button
              className="quoterow__btn"
              onClick={() => {
                setAsking(false);
                setDeleteError("");
              }}
              disabled={deleting}
            >
              Keep it
            </button>
          </span>
        ) : (
          <button
            className="quoterow__delete"
            onClick={() => setAsking(true)}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}
