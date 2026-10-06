// netlify/lib/gsm.mjs
//
// How a text is actually encoded, and therefore what it costs.
//
// Split out of sms.mjs because the BROWSER needs it too. The composer in the
// thread shows "1 message" or "2 messages" under the box as you type, and
// that number has to be the same number the sender works out — otherwise the
// counter says one thing, the bill says another, and the person typing is
// the one who notices.
//
// This file imports nothing. That is the point of it existing separately:
// sms.mjs reaches Quo and reads process.env and must never end up in a
// browser bundle, and the only way to be sure of that is for the shared part
// to have no way of dragging it along.
//
// sms.mjs re-exports both functions, so every existing import of them from
// there still works.

/**
 * Fold the characters a Mac or an iPhone inserts on your behalf back into
 * ones a phone network can carry in seven bits.
 *
 * This is not cosmetic. A message is billed and delivered in segments of 160
 * GSM-7 characters — but ONE character outside that alphabet switches the
 * whole message to UCS-2, where a segment is 70 characters. A single curly
 * apostrophe in "Here's your quote" therefore more than doubles the number
 * of segments, the cost, and the number of separate notifications the
 * customer's phone may show.
 *
 * The em dash is the one that bites, because it is what everything types
 * automatically and what reads best in the messages this CRM sends.
 *
 * Written as \u escapes rather than as the characters themselves. A function
 * whose entire job is removing characters that do not survive transit should
 * not itself depend on this file's encoding surviving transit — and the row
 * of space variants, typed literally, is three invisible glyphs that look
 * exactly like one ordinary space.
 */
export function gsmSafe(s) {
  return String(s ?? "")
    .replace(/[—–−]/g, "-")   // em dash, en dash, minus
    .replace(/[‘’‛]/g, "'")  // curly single quotes
    .replace(/[“”]/g, '"')         // curly double quotes
    .replace(/…/g, "...")                // ellipsis
    .replace(/[   ]/g, " ")   // non-breaking, narrow, thin
    .replace(/•/g, "*");                 // bullet
}

// The GSM-7 alphabet, for working out how a message will actually be billed.
// The extension characters (^{}[]~|\ and €) each take TWO septets, which is
// why they are counted separately rather than just being "in the set".
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

export function segmentsFor(text) {
  const s = String(text ?? "");
  let septets = 0;
  let gsm = true;

  for (const ch of s) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (!gsm) {
    // UCS-2. Counted in code UNITS, not code points — an emoji is a
    // surrogate pair and costs two.
    const units = [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
    return { encoding: "UCS-2", length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
  }

  return {
    encoding: "GSM-7",
    length: septets,
    segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}
