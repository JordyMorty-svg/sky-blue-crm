import { useCallback, useEffect, useState } from "react";
import QuoteModal from "./QuoteModal";
import {
  SERVICE_LABELS,
  fetchQuotes,
  money,
  quoteState,
  shortDate,
  smsHref,
  smsText,
} from "../services/quoteService";
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
  // Leads move to Booked when a quote is accepted, so the page behind this
  // needs a chance to re-read itself.
  onChanged,
}) {
  const [quotes, setQuotes] = useState([]);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setQuotes(await fetchQuotes({ leadId, customerId }));
      setLoadError("");
    } catch (e) {
      console.error("Couldn't load quotes:", e);
      // Says so rather than rendering an empty list. An empty list here reads
      // as "we never quoted them", which is the one wrong answer that makes
      // someone send a second quote at a different price.
      setLoadError("Couldn't load past quotes.");
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
        <button className="quotes__send" onClick={() => setOpen(true)}>
          {quotes.length ? "Send another quote" : "Send a quote"}
        </button>
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
              key={q.id}
              quote={q}
              customerName={customerName}
              customerPhone={customerPhone}
            />
          ))}
        </ul>
      )}

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

function QuoteRow({ quote, customerName, customerPhone }) {
  const state = quoteState(quote);
  const [copied, setCopied] = useState(false);

  // Built here rather than stored, so a quote sent before the domain moved
  // still produces a link on today's domain.
  const link = `${window.location.origin}/q/${quote.token}`;
  const resendable = state.key === "sent" || state.key === "viewed" || state.key === "draft";

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

      <p className="quoterow__meta">
        Sent {shortDate(quote.sent_at || quote.created_at)}
        {quote.sender?.full_name ? ` by ${quote.sender.full_name}` : ""}
        {quote.accepted_at ? ` · accepted ${shortDate(quote.accepted_at)}` : ""}
      </p>

      {resendable && (
        <div className="quoterow__actions">
          {customerPhone && (
            <a
              className="quoterow__btn"
              href={smsHref(
                customerPhone,
                smsText({ customerName, amount: quote.amount, link })
              )}
            >
              Text the link
            </a>
          )}
          <button className="quoterow__btn" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
          {/* Deliberately no Preview button. Fetching the quote page is what
              flips `sent` to `viewed` — the database cannot tell a curious rep
              from the customer — so a preview would quietly turn "Sent, not
              opened yet" into "Opened, not accepted" on a quote nobody has
              read. That distinction is the whole reason to follow up, so it
              is worth more than the convenience of looking. */}
        </div>
      )}
    </li>
  );
}
