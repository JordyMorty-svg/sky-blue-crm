// netlify/lib/html.mjs
//
// The two things every server-rendered email needs, in one place.
//
// Both of these existed as private copies inside send-quote.mjs. They are
// shared now because notify.mjs needs the same two, and a second copy of an
// ESCAPER is the kind of duplication that turns into a hole: one of them gets
// a fix — a new entity, a quote style, an attribute context — and the other
// quietly doesn't.

/**
 * Escape text for an HTML body.
 *
 * Everything that reaches an email body from the CRM was typed by a person on
 * a phone, at a door: customer names, addresses, the note field. A stray
 * angle bracket must not be able to rewrite the markup around it, and an
 * apostrophe in "O'Brien" must not be able to close an attribute.
 *
 * Both quote characters are escaped, not just the double, so the output is
 * safe inside single-quoted attributes as well as double-quoted ones. That
 * costs nothing and removes a footgun from every future caller.
 */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A dollar amount, always with cents.
 *
 * Always two decimal places, deliberately: "$450" and "$450.00" in the same
 * inbox read as two different numbers at a glance, and the notification
 * emails sit directly alongside the customer-facing quote.
 */
export function money(n) {
  return `$${Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Service keys are stored, not labels — so an email has to translate. Kept
// server-side rather than imported from src/services/leadService.js because
// anything under src/ drags in the browser Supabase client and
// import.meta.env, neither of which exists in a Netlify function.
export const SERVICE_LABELS = {
  "residential-window-washing": "Residential window washing",
  "commercial-window-washing": "Commercial window washing",
  "gutter-cleaning": "Gutter cleaning",
  "screen-cleaning-repair": "Screen cleaning & repair",
  "pressure-washing": "Pressure washing",
  "solar-panel-cleaning": "Solar panel cleaning",
};

/** Service keys to a readable list, falling back to the raw key. */
export function serviceLabels(keys) {
  return (keys || []).map((k) => SERVICE_LABELS[k] || k);
}
