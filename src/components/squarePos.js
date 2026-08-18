// Square Point of Sale API — hand off a charge to the Square app so the
// customer can tap, then come back here.
//
// WHY this exists rather than just taking the card in the CRM:
// entering card numbers into our own form is "card not present" as far as
// Square is concerned, and priced accordingly (3.5% + 15c at time of
// writing). A tap on the same phone is an in-person transaction (2.6% +
// 15c). On a $399 job that's about $3.60, which is real money on every
// visit for a two-person business.
//
// Tap to Pay itself needs Apple's ProximityReader entitlement, which is
// only ever granted to native iOS apps — a browser cannot do it, and no
// amount of JavaScript changes that. What a browser CAN do is deep-link
// into the Square Point of Sale app, which has the entitlement, let it
// take the tap, and receive the result back on a callback URL. That's
// what this file builds.
//
// Docs: https://developer.squareup.com/docs/pos-api/build-mobile-web

const IOS_SCHEME = "square-commerce-v1://payment/create";
// Each platform versions the POS API separately. These are not typos.
const IOS_API_VERSION = "1.3";
const ANDROID_API_VERSION = "v2.0";

// Where Square sends the customer back to. A real route in this app —
// see PosReturn.jsx.
export const POS_RETURN_PATH = "/pos-return";

// ---------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------

export function isIOS() {
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac, so touch support is the tiebreak.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes("Mac") && typeof document !== "undefined" && "ontouchend" in document)
  );
}

export function isAndroid() {
  return /Android/.test(navigator.userAgent || "");
}

// The hand-off only exists on a phone — there's no Square app on a laptop,
// and no card to tap against it. Desktop keeps the typed-card form.
export function canUseSquarePos() {
  return isIOS() || isAndroid();
}

// ---------------------------------------------------------------------
// Remembering what we were doing
// ---------------------------------------------------------------------
//
// Leaving for another app tears down this page. On the way back the app
// boots fresh, so anything the operator had typed — the final amount, a
// plan they just agreed, a note, a corrected email — is gone unless it's
// written down first.
//
// localStorage rather than sessionStorage because iOS may return into a
// different tab than the one that left, and sessionStorage is per-tab.
// Same try/catch treatment as viewMemory.js: private-browsing modes throw,
// and a payment must not be blocked by a storage quirk.

const PENDING_KEY = "crmPendingPosPayment";

export function rememberPendingPayment(pending) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage unavailable. The return path falls back to the job id that
    // Square echoes back in `state`, so the payment still completes — it
    // just re-reads the plan and email from the customer record.
  }
}

export function readPendingPayment(jobId) {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY));
    if (!raw) return null;
    // Guard against a stale entry from an abandoned hand-off on a
    // different job.
    if (jobId && raw.jobId !== jobId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function clearPendingPayment() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to do — a stale entry is discarded on read by the job check.
  }
}

// ---------------------------------------------------------------------
// Building the link
// ---------------------------------------------------------------------

function centsOf(amount) {
  return Math.round(Number(amount) * 100);
}

function callbackUrl() {
  return `${window.location.origin}${POS_RETURN_PATH}`;
}

/**
 * The URL that opens Square Point of Sale with the charge queued up.
 *
 * `state` comes back to us untouched, so the job id rides along in it —
 * that's what lets the return page know which job was just paid for even
 * if local storage was unavailable.
 */
export function buildPosUrl({ amount, jobId, note }) {
  const cents = centsOf(amount);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new Error("Enter the amount before tapping a card.");
  }

  const clientId = import.meta.env.VITE_SQUARE_APP_ID;
  if (!clientId) {
    throw new Error("VITE_SQUARE_APP_ID isn't set, so Square can't be opened.");
  }
  const locationId = import.meta.env.VITE_SQUARE_LOCATION_ID;

  if (isIOS()) {
    const data = {
      amount_money: { amount: cents, currency_code: "USD" },
      callback_url: callbackUrl(),
      client_id: clientId,
      version: IOS_API_VERSION,
      notes: note || undefined,
      state: jobId,
      location_id: locationId || undefined,
      options: {
        // Card only. Cash and cheque are recorded in the CRM directly —
        // routing them through Square would mean two records of one
        // payment and no way to tell which is authoritative.
        supported_tender_types: ["CREDIT_CARD"],
        auto_return: true,
      },
    };
    return `${IOS_SCHEME}?data=${encodeURIComponent(JSON.stringify(data))}`;
  }

  if (isAndroid()) {
    // Android takes a raw intent URL: S. is a string extra, i. an int,
    // l. a long. Values must be encoded — the callback URL contains
    // characters that would otherwise end the intent early.
    const parts = [
      "intent:#Intent",
      "action=com.squareup.pos.action.CHARGE",
      "package=com.squareup",
      `S.com.squareup.pos.WEB_CALLBACK_URI=${encodeURIComponent(callbackUrl())}`,
      `S.com.squareup.pos.CLIENT_ID=${encodeURIComponent(clientId)}`,
      `S.com.squareup.pos.API_VERSION=${ANDROID_API_VERSION}`,
      `i.com.squareup.pos.TOTAL_AMOUNT=${cents}`,
      "S.com.squareup.pos.CURRENCY_CODE=USD",
      "S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD",
      `S.com.squareup.pos.REQUEST_METADATA=${encodeURIComponent(jobId)}`,
      // Where Android sends you if the Square app isn't installed. Without
      // this the tap button appears to do nothing at all.
      `S.browser_fallback_url=${encodeURIComponent(
        `${callbackUrl()}?notInstalled=1&state=${encodeURIComponent(jobId)}`
      )}`,
    ];
    if (locationId) {
      parts.push(`S.com.squareup.pos.LOCATION_ID=${encodeURIComponent(locationId)}`);
    }
    if (note) {
      parts.push(`S.com.squareup.pos.NOTE=${encodeURIComponent(note.slice(0, 500))}`);
    }
    parts.push("end");
    return parts.join(";");
  }

  throw new Error("Tapping a card needs the Square app on a phone.");
}

// ---------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------

// The two platforms answer in completely different shapes: iOS returns one
// JSON blob in a `data` param, Android returns flat query parameters with
// fully-qualified names. Normalised here so nothing downstream has to care.
export function parsePosCallback(search) {
  const params = new URLSearchParams(search);

  if (params.get("notInstalled")) {
    return {
      ok: false,
      jobId: params.get("state") || null,
      errorCode: "APP_NOT_INSTALLED",
    };
  }

  // --- iOS ---
  const data = params.get("data");
  if (data) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { ok: false, jobId: null, errorCode: "BAD_RESPONSE" };
    }
    return {
      ok: parsed.status === "ok",
      jobId: parsed.state || null,
      // Square's own docs call this the transaction id; it doubles as the
      // ORDER id, which is how the payment is looked up later.
      transactionId: parsed.transaction_id || null,
      clientTransactionId: parsed.client_transaction_id || null,
      errorCode: parsed.error_code || null,
    };
  }

  // --- Android ---
  const androidError = params.get("com.squareup.pos.ERROR_CODE");
  const serverTxn = params.get("com.squareup.pos.SERVER_TRANSACTION_ID");
  const clientTxn = params.get("com.squareup.pos.CLIENT_TRANSACTION_ID");
  const metadata = params.get("com.squareup.pos.REQUEST_METADATA");

  if (androidError || serverTxn || clientTxn) {
    return {
      ok: !androidError && !!serverTxn,
      jobId: metadata || null,
      transactionId: serverTxn || null,
      clientTransactionId: clientTxn || null,
      errorCode: androidError || null,
      errorDetail: params.get("com.squareup.pos.ERROR_DESCRIPTION") || null,
    };
  }

  return null; // not a Square callback at all
}

// Square's error codes, written for whoever is standing on a doorstep
// rather than for a log file.
const POS_ERRORS = {
  APP_NOT_INSTALLED:
    "The Square app isn't installed on this phone. Install Square Point of Sale, sign in, and try again — or take the card in the CRM instead.",
  TRANSACTION_CANCELED: "The payment was cancelled in Square. Nothing was charged.",
  PAYMENT_CANCELED: "The payment was cancelled in Square. Nothing was charged.",
  CUSTOMER_MANAGEMENT_NOT_SUPPORTED:
    "Square couldn't attach this to a customer. The payment can still be taken in the CRM.",
  INVALID_REQUEST: "Square rejected the request. Check the amount and try again.",
  NO_RESULT: "Square didn't say how that ended. Check the Square app before retrying, so nobody gets charged twice.",
  NOT_AUTHORIZED:
    "This Square account isn't authorised for the Point of Sale API. Check the application id in your Square developer dashboard.",
  UNSUPPORTED_API_VERSION:
    "The Square app is too old for this. Update Square Point of Sale and try again.",
  USER_NOT_ACTIVATED: "This Square account can't take payments yet — finish activation in the Square app.",
  USER_NOT_LOGGED_IN: "Nobody is signed in to the Square app on this phone.",
  INSUFFICIENT_CARD_BALANCE: "The card was declined for insufficient funds.",
  BAD_RESPONSE: "Square's reply couldn't be read. Check the Square app for whether the payment went through.",
};

export function posErrorMessage(code) {
  return (
    POS_ERRORS[code] ||
    "That payment didn't complete in Square. Check the Square app before retrying, so nobody gets charged twice."
  );
}
