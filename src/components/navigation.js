import { isIOS, isAndroid } from "./squarePos";

/**
 * Opening a job's address in whatever maps app the crew actually uses.
 *
 * The honest constraint first: a web page cannot ask the operating system
 * which maps app is the default. There is no such API on any platform.
 * What can be done differs by platform, so this file does different things
 * rather than pretending one link works everywhere:
 *
 *   Android — a `geo:` URI hands the address to Android, which opens the
 *     user's chosen maps app (or offers a chooser). This genuinely honours
 *     the default, because Android is the one making the decision.
 *
 *   iOS — Safari doesn't support `geo:`, and iOS has no user-visible
 *     "default maps app" outside the EU. Apple Maps and Google Maps have
 *     to be linked separately, so the CRM keeps the preference the OS
 *     won't: asked once per phone, remembered after that.
 *
 *   Desktop — Google Maps on the web, which needs nothing installed.
 */

export const MAPS_APPS = [
  { key: "apple", label: "Apple Maps" },
  { key: "google", label: "Google Maps" },
];

const PREF_KEY = "crmMapsApp";

// Same try/catch treatment as the rest of the app's storage: private
// browsing throws, and a convenience must never break a page.
export function readMapsPref() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return MAPS_APPS.some((a) => a.key === v) ? v : null;
  } catch {
    return null;
  }
}

export function setMapsPref(key) {
  try {
    localStorage.setItem(PREF_KEY, key);
  } catch {
    // Not remembered — they'll be asked again, which is survivable.
  }
}

export function clearMapsPref() {
  try {
    localStorage.removeItem(PREF_KEY);
  } catch {
    // Nothing to do.
  }
}

// Coordinates beat an address string: they can't be mis-geocoded, and a
// rural address on the edge of Corvallis is exactly where that goes wrong.
// The address is the fallback, and also what gets shown as the pin label.
function destinationOf({ address, latitude, longitude }) {
  return hasUsableCoords(latitude, longitude)
    ? `${latitude},${longitude}`
    : address || "";
}

// Deliberately fussy, because the failure mode is silent and expensive:
// Number(null) and Number("") are both 0, which is a perfectly finite
// number, so a naive isFinite check treats a customer with no geocoded
// address as being at latitude 0, longitude 0 — a spot in the Atlantic off
// west Africa. The crew would get directions and no reason to doubt them.
//
// 0,0 is rejected outright for the same reason: it is never a real Oregon
// address, and it is exactly what a half-filled row looks like.
function hasUsableCoords(latitude, longitude) {
  if (latitude === null || latitude === undefined || latitude === "") return false;
  if (longitude === null || longitude === undefined || longitude === "") return false;

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;

  return true;
}

export function appleMapsUrl(place) {
  const daddr = destinationOf(place);
  // dirflg=d asks for driving directions rather than a dropped pin.
  return `https://maps.apple.com/?daddr=${encodeURIComponent(daddr)}&dirflg=d`;
}

export function googleMapsUrl(place) {
  const destination = destinationOf(place);
  // Google's documented universal URL: opens the app when installed on
  // either platform, and the website when it isn't.
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    destination
  )}`;
}

export function geoUrl(place) {
  const dest = destinationOf(place);
  // A label only helps when the query is coordinates — with an address the
  // address IS the label.
  const hasCoords = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(dest);
  const label = hasCoords && place.label ? `(${place.label})` : "";
  return `geo:0,0?q=${encodeURIComponent(dest + label)}`;
}

/**
 * The URL to open for this place, or null when iOS needs to be asked which
 * app to use first.
 *
 * `app` forces a specific choice and is what the chooser passes in.
 */
export function navigationUrl(place, app = null) {
  if (!destinationOf(place)) return null;

  if (app === "apple") return appleMapsUrl(place);
  if (app === "google") return googleMapsUrl(place);

  // Android decides for itself, which is the behaviour being asked for.
  if (isAndroid()) return geoUrl(place);

  if (isIOS()) {
    const pref = readMapsPref();
    return pref ? navigationUrl(place, pref) : null; // null = ask first
  }

  return googleMapsUrl(place);
}

// True when tapping Navigate has to ask before it can do anything.
export function needsMapsChoice() {
  return isIOS() && !readMapsPref();
}

/**
 * Hand the URL off to the OS.
 *
 * A custom scheme has to be a top-level navigation to reach an app. An
 * https link must NOT be, or an installed CRM would navigate itself to
 * Google Maps and the crew would lose their place.
 */
export function openNavigation(url) {
  if (!url) return;
  if (/^https?:/i.test(url)) {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    window.location.href = url;
  }
}

// What to feed the functions above, given a job row.
export function placeForJob(job) {
  const customer = job?.customer;
  const lead = job?.lead;
  return {
    address: customer?.address || lead?.address || "",
    latitude: customer?.latitude ?? lead?.latitude ?? null,
    longitude: customer?.longitude ?? lead?.longitude ?? null,
    label: customer?.name || lead?.name || "Job",
  };
}
