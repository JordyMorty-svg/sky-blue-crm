/*
 * Ringing somebody through Quo, from wherever the number is shown.
 *
 * ONE PLACE, because there are now two: the Call button on the reach card
 * and the phone number in the record header. They were drifting already —
 * the header was a plain `openphone://` link, which on a laptop does
 * nothing at all. You press the number, the page does not move, and there
 * is no way to tell whether the click missed or the app is missing.
 *
 * WHY IT IS TWO DIFFERENT ACTIONS. Quo's deep link opens the Quo app, and
 * the Quo app is a phone app. On a desktop the honest answer is to put the
 * number on the clipboard and open the Quo web dialler, which is one paste
 * from a call. Guessing wrong in either direction is worse than asking:
 * a deep link on a laptop is a dead click, and a clipboard write on a
 * phone is a detour past the thing that would have just worked.
 *
 * NOTHING HERE LOGS A CALL — see db/call-tracking.sql. The call is written
 * down when Quo says it happened, on the call.completed webhook. An
 * earlier version logged on click, so a mis-tap from a laptop with no
 * dialler wrote "Called" onto somebody's history.
 */

import { isAndroid, isIOS } from "../components/squarePos";
import { QUO_WEB, quoCallHref } from "./leadService";

/**
 * The number as Quo's dialler wants it — E.164 where we can manage it.
 *
 * Falls back to the raw string rather than refusing: an extension or an
 * international number that this cannot normalise is still worth putting
 * on the clipboard, because a human can fix it in the dialler and cannot
 * fix an empty clipboard.
 */
export function dialableNumber(phone) {
  const fromLink = (quoCallHref(phone) || "").match(/number=([^&]+)/)?.[1];
  return fromLink ? decodeURIComponent(fromLink) : String(phone ?? "");
}

/**
 * Put the number on the clipboard and open the Quo web dialler.
 *
 * Returns true when the copy worked, so a caller can say "Copied" rather
 * than claiming it on faith. Quo opens either way: failing to copy must
 * not also fail to open it — arriving with the number still in your head
 * is the worse half of the job done, not none of it.
 */
export async function copyNumberAndOpenQuo(phone) {
  let copied = false;
  try {
    // Secure contexts only, which crm.skybluecleaningco.com is. Wrapped
    // anyway: a denied permission or an older browser throws here.
    await navigator.clipboard.writeText(dialableNumber(phone));
    copied = true;
  } catch (e) {
    console.error("Couldn't copy the number:", e);
  }
  window.open(QUO_WEB, "_blank", "noopener,noreferrer");
  return copied;
}

/**
 * Ring them, by whichever route this device actually has.
 *
 * On a phone: the Quo app. Anywhere else: clipboard plus the web dialler.
 */
export async function callThroughQuo(phone) {
  if (!phone) return false;

  if (isIOS() || isAndroid()) {
    const link = quoCallHref(phone);
    if (link) {
      window.location.href = link;
      return false;
    }
  }

  return copyNumberAndOpenQuo(phone);
}
