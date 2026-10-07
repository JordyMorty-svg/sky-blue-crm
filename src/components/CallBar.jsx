import { useState } from "react";
import { QUO_WEB, formatPhone, quoCallHref, telHref } from "../services/leadService";
import { whenReached } from "../services/contactService";
import "./CallBar.css";

/**
 * The number, how to ring it, and when anybody last tried.
 *
 * One component for the lead's and the customer's communication pages,
 * which drew the identical card twice until this existed.
 *
 * TWO BUTTONS, AND THE SECOND ONE IS THE POINT.
 *
 * Quo publishes no API for placing a call — messages, contacts and
 * conversations only — so the only way a call goes through Quo is one of
 * its apps. On a phone the `openphone://dial` scheme opens the app and
 * dials. On a DESKTOP, Quo documents that scheme as mobile-only, and if the
 * Quo desktop app has not registered the handler the Call button does
 * exactly nothing: no dialler, no error, no call. Which is what happened —
 * the button was shipped with a comment claiming a web fallback existed
 * beside it, and no fallback was ever built.
 *
 * So there is a second button that always works: it copies the number and
 * opens the Quo web app. One click, paste, dial. Not as neat as the deep
 * link, and much better than a button that silently does nothing.
 *
 * NEITHER BUTTON RECORDS ANYTHING. The call is written down when Quo says
 * it happened, on the call.completed webhook — db/call-tracking.sql. That
 * also means a call placed from a personal handset instead of from Quo
 * will never appear here, which is the trade: only calls Quo carried can be
 * calls Quo confirms.
 */
export default function CallBar({ phone, lastContactedAt, attempts }) {
  const [copied, setCopied] = useState(false);

  if (!phone) {
    return (
      <section className="callbar">
        <p className="callbar__last">No phone number on file.</p>
      </section>
    );
  }

  const dial = quoCallHref(phone) || telHref(phone);
  // E.164 where we can, because that is what gets pasted into Quo's dialler.
  // Falling back to the raw digits keeps an extension or an international
  // number copyable rather than refusing to copy it at all.
  const toCopy = (quoCallHref(phone) || "").match(/number=([^&]+)/)?.[1]
    ? decodeURIComponent(quoCallHref(phone).match(/number=([^&]+)/)[1])
    : String(phone);

  async function copyAndOpen() {
    try {
      // Secure contexts only, which crm.skybluecleaningco.com is. Wrapped
      // anyway: a denied permission or an older browser throws here, and
      // failing to copy must not also fail to open Quo — getting there with
      // the number still in your head is the worse half of the job done.
      await navigator.clipboard.writeText(toCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Couldn't copy the number:", e);
    }
    window.open(QUO_WEB, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="callbar">
      <div className="callbar__row">
        {/* Formatted, because this is the number somebody reads off the
            screen while dialling on a different handset. */}
        <span className="callbar__phone">{formatPhone(phone)}</span>

        {dial && (
          <a className="callbar__call" href={dial}>
            Call
          </a>
        )}

        <button type="button" className="callbar__web" onClick={copyAndOpen}>
          {copied ? "Copied — opening Quo" : "Copy & open Quo"}
        </button>
      </div>

      <p className="callbar__last">
        {lastContactedAt ? (
          <>
            Last reached out {whenReached(lastContactedAt)}
            {attempts > 1 ? ` · ${attempts} attempts` : ""}
          </>
        ) : (
          "Nobody has reached out yet."
        )}
      </p>

      {/* Said plainly rather than left to be discovered. Somebody pressing
          Call on a laptop and getting nothing will otherwise conclude the
          feature is broken — which is exactly what happened. */}
      <p className="callbar__hint">
        Call opens the Quo app, which only works on a phone. On a computer,
        use Copy &amp; open Quo.
      </p>
    </section>
  );
}
