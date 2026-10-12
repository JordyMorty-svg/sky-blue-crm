import { useState } from "react";
import { setEmailOptOut, setCustomerReviewed } from "../services/followUpService";
import "../pages/customers/Customers.css";

/*
 * Should this person hear from us?
 *
 * MOVED OFF THE CUSTOMER PROFILE, where these two tickboxes sat directly
 * under the address and were the third thing anybody's eye landed on. They
 * are settings — glanced at occasionally, changed rarely — and they were
 * taking the position that belongs to who this person is and what work they
 * have booked.
 *
 * They live on the Communication tab now, which is the page you are already
 * on when the question "should we be emailing them?" occurs to you.
 *
 * ONE GROUP, because they answer the same question, and reading them as a
 * pair is what makes the difference between them obvious. Side by side on a
 * desktop, stacked on a phone, from one auto-fit grid rather than a
 * breakpoint.
 *
 * SAVES IMMEDIATELY, both of them. This gets ticked while looking at a
 * Google notification on a phone, not while filling in a form — a change
 * that needed a separate Save press would be a change that silently did not
 * happen. onChanged reloads the record so the rest of the page agrees.
 */
export default function CustomerPrefs({ customer, onChanged }) {
  const [optBusy, setOptBusy] = useState(false);
  const [revBusy, setRevBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleOptOut(e) {
    const next = e.target.checked;
    setOptBusy(true);
    setError("");
    try {
      await setEmailOptOut(customer.id, next);
      await onChanged?.();
    } catch (err) {
      console.error(err);
      setError("Couldn't change the email setting.");
    } finally {
      setOptBusy(false);
    }
  }

  async function handleReviewed(e) {
    const next = e.target.checked;
    setRevBusy(true);
    setError("");
    try {
      await setCustomerReviewed(customer.id, next);
      await onChanged?.();
    } catch (err) {
      console.error(err);
      setError("Couldn't change the review setting.");
    } finally {
      setRevBusy(false);
    }
  }

  return (
    <section className="custprefs__section">
      {/* The same section shape as the thread, the quotes panel and the
          history — a rule, a heading, then the content. These stack on one
          page and have to read as the same kind of thing; a bare pair of
          tickboxes between two titled sections is what made this page look
          like it had been assembled rather than designed. */}
      <h3 className="custprefs__sectiontitle">Email &amp; reviews</h3>
    <div className="custprefs">
      {/* Named for what is actually in the group. On a customer with
          no email address the opt-out switch below is hidden, which
          left the word "Email" sitting on its own above a tickbox
          about Google reviews — a heading describing a control that
          wasn't there. */}
      <span className="custprefs__head">
        {customer.email ? "Email" : "Reviews"}
      </span>
      <div className="custprefs__grid">
        {/* Only where there's an address. On a customer with no email
            this would be a switch that governs nothing. */}
        {customer.email && (
          <label
            className={
              "custpref" + (customer.email_opt_out ? " custpref--on" : "")
            }
          >
            <input
              type="checkbox"
              checked={!!customer.email_opt_out}
              onChange={handleOptOut}
              disabled={optBusy}
            />
            <span className="custpref__body">
              <span className="custpref__label">
                Don&rsquo;t send follow-up emails
              </span>
              {/* The hint carries STATE, not instructions. A line
                  telling you what a tickbox does is read once and then
                  becomes clutter forever; a date is useful every time. */}
              {customer.email_opt_out ? (
                <span className="custpref__hint">
                  Nothing automatic will send
                </span>
              ) : (
                customer.last_review_request_at && (
                  <span className="custpref__hint">
                    Last asked{" "}
                    {new Date(
                      customer.last_review_request_at
                    ).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                )
              )}
            </span>
          </label>
        )}

        {/* Not conditional on having an email: whether they reviewed is
            true regardless, and hiding it would mean a customer who
            reviewed and later lost their address quietly became
            askable again. */}
        <label
          className={
            "custpref" + (customer.reviewed_at ? " custpref--on" : "")
          }
        >
          <input
            type="checkbox"
            checked={!!customer.reviewed_at}
            onChange={handleReviewed}
            disabled={revBusy}
          />
          <span className="custpref__body">
            <span className="custpref__label">
              Already left a Google review
            </span>
            {customer.reviewed_at && (
              <span className="custpref__hint">
                Recorded{" "}
                {new Date(customer.reviewed_at).toLocaleDateString(
                  "en-US",
                  { month: "short", day: "numeric", year: "numeric" }
                )}
              </span>
            )}
          </span>
        </label>
      </div>
    </div>
      {error && <p className="custdetail__error">{error}</p>}
    </section>
  );
}
