import { useState } from "react";
import {
  SERVICE_OPTIONS,
  money,
  sendQuote,
  smsHref,
  smsText,
} from "../services/quoteService";
import "./QuoteModal.css";

/**
 * Compose and send a quote, from a lead or a customer.
 *
 * Two outcomes, both normal:
 *
 *   * There's an email on file — it sends, and you're done.
 *   * There isn't — you get the link and a prefilled text. Most customers
 *     added through Add past jobs have no email, and the person quoting is
 *     standing on a driveway with a phone, so "no email" has to be a path
 *     through this screen rather than a dead end at the start of it.
 *
 * The sent state is deliberately NOT a toast that disappears. When there's no
 * email the whole point of the screen is the link, and it has to stay on
 * screen until it has been copied or texted.
 */

const DEFAULT_SERVICE = "residential-window-washing";

export default function QuoteModal({
  leadId = null,
  customerId = null,
  customerName,
  customerEmail = null,
  customerPhone = null,
  address = null,
  suggestedAmount = null,
  suggestedServices = null,
  onClose,
  onSent,
}) {
  const [amount, setAmount] = useState(
    suggestedAmount ? String(suggestedAmount) : ""
  );
  const [services, setServices] = useState(
    suggestedServices?.length ? suggestedServices : [DEFAULT_SERVICE]
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { link, emailed }
  const [copied, setCopied] = useState(false);

  function toggleService(key) {
    setServices((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    );
  }

  async function handleSend() {
    setError("");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Put a price on it first.");
      return;
    }
    if (services.length === 0) {
      setError("Pick at least one service.");
      return;
    }

    setBusy(true);
    try {
      const res = await sendQuote({
        leadId,
        customerId,
        customerName,
        customerEmail,
        address,
        serviceKeys: services,
        amount: value,
        note: note.trim() || null,
      });
      setResult(res);
      // Refreshes the record behind the modal. Called on success even when
      // the email didn't go, because the QUOTE exists either way and the
      // history list should show it.
      onSent?.(res);
    } catch (e) {
      console.error(e);
      setError(e.message || "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused on an insecure origin and in some
      // in-app browsers. The link is already on screen and selectable, so
      // this is a missing convenience rather than a failure worth an alert.
      setCopied(false);
    }
  }

  const text = result
    ? smsText({ customerName, amount: Number(amount), link: result.link })
    : "";

  return (
    <div className="quotem__backdrop" onClick={onClose}>
      <div
        className="quotem"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Quote for ${customerName}`}
      >
        {!result ? (
          <>
            <h2 className="quotem__title">Quote for {customerName}</h2>
            {address && <p className="quotem__address">{address}</p>}

            <label className="quotem__label" htmlFor="quote-amount">
              Price
            </label>
            <div className="quotem__amountwrap">
              <span className="quotem__currency">$</span>
              <input
                id="quote-amount"
                className="quotem__amount"
                // `decimal` rather than `numeric`: it gives a keypad with a
                // decimal point on iOS, which "250.50" needs.
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="250"
                autoFocus
              />
            </div>

            <span className="quotem__label">What's included</span>
            <div className="quotem__services">
              {SERVICE_OPTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`quotem__service ${
                    services.includes(s.key) ? "quotem__service--on" : ""
                  }`}
                  onClick={() => toggleService(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <label className="quotem__label" htmlFor="quote-note">
              Note <span className="quotem__optional">(optional)</span>
            </label>
            <textarea
              id="quote-note"
              className="quotem__note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything they should know — access, timing, what's not included."
              rows={3}
            />

            <p className="quotem__dest">
              {customerEmail ? (
                <>Sends to <b>{customerEmail}</b></>
              ) : (
                <>
                  No email on file — you&rsquo;ll get a link to text them
                  instead.
                </>
              )}
            </p>

            {error && <p className="quotem__error">{error}</p>}

            <div className="quotem__actions">
              <button
                className="quotem__send"
                onClick={handleSend}
                disabled={busy}
              >
                {busy
                  ? "Sending…"
                  : customerEmail
                    ? `Send quote${amount ? ` · ${money(amount)}` : ""}`
                    : "Create quote link"}
              </button>
              <button className="quotem__cancel" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="quotem__title">
              {result.emailed ? "Quote sent" : "Quote ready"}
            </h2>

            {result.emailed ? (
              <p className="quotem__sentnote">
                Emailed to <b>{customerEmail}</b>. You&rsquo;ll see it move to
                Booked here the moment they accept.
              </p>
            ) : (
              <p className="quotem__sentnote">
                {result.emailError
                  ? "The quote is saved, but the email didn't go. Send them the link instead — it works the same."
                  : "Send them this link. Accepting it books the job automatically."}
              </p>
            )}

            {!result.emailed && (
              <>
                <div className="quotem__link">{result.link}</div>
                <div className="quotem__actions">
                  {customerPhone && (
                    <a
                      className="quotem__send"
                      href={smsHref(customerPhone, text)}
                    >
                      Text it to {customerName.split(" ")[0]}
                    </a>
                  )}
                  <button className="quotem__cancel" onClick={copyLink}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </>
            )}

            <button className="quotem__done" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
