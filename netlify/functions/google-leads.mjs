// netlify/functions/google-leads.mjs
//
// Pulling Local Services leads out of Google Ads and into the CRM.
//
// WHY THIS EXISTS. LSA is pay-per-lead: Google charges for a call, a message
// or a booking, and those leads live in Google's own inbox. The one channel
// Sky Blue pays per-lead for is the one channel the CRM cannot see.
//
// WHY IT POLLS. There is no webhook. Google exposes leads through
// GoogleAdsService.search and nothing pushes them, so this runs on a schedule
// alongside the nightly SMS and follow-up runs.
//
// WHY THE GOOGLE ADS API AND NOT THE LOCAL SERVICES API. Both exist. The
// older standalone one (localservices_v1.detailedLeadReports) is being
// retired as LSAs fold into Google Ads as a Performance Max pay-per-lead
// campaign type — phase 1 began August 2026 with US home services, and the
// standalone dashboard at g.co/localservices goes away once an account
// migrates. The Ads API is where leads live on both sides of that, so this
// is built against the one that survives.
//
// IT HOLDS NO POLICY. Whether a lead attaches to somebody who already exists,
// whether it counts as new, what a missing name means — all of that is
// record_google_lead() in db/google-leads.sql, where it is tested against a
// real Postgres. This file fetches pages and hands them over.
//
// Required Netlify environment variables:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
//       — an OAuth client and a refresh token for a Google account with
//         access to the Ads account. Scope: .../auth/adwords
//   GOOGLE_ADS_CUSTOMER_ID — the Ads customer id, digits only (no dashes)
//   SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL — already set
//
// Optional:
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID — the manager account, when the Ads account
//       sits under one. Digits only.
//   GOOGLE_ADS_DEVELOPER_TOKEN — since 10 Sep 2026 Google attaches API access
//       to the Cloud project and ignores this header, but it is still sent
//       when present so an older account keeps working.
//   GOOGLE_ADS_API_VERSION — defaults below. Google retires versions roughly
//       yearly, and a hardcoded one is a time bomb that goes off on a
//       Saturday.
//   GOOGLE_LEADS_BACKFILL_DAYS — how far back the FIRST run reaches.

import { rpc } from "../lib/db.mjs";

// The version the field names below were confirmed against.
const API_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || "v22";

// How far back to look when the table is empty. Long enough to pick up the
// leads that already exist, short enough not to page forever on the first run.
const FIRST_RUN_DAYS = () => Number(process.env.GOOGLE_LEADS_BACKFILL_DAYS) || 90;

// How far BEFORE the newest lead we already have to start reading.
//
// The window overlaps on purpose. Google's creation_date_time is in the
// account's timezone and a lead can appear a little out of order, so starting
// exactly at the high-water mark would step over anything that arrived late.
// Re-reading costs nothing — record_google_lead() deduplicates on Google's own
// id and reports a repeat as "nothing new".
const OVERLAP_HOURS = 6;

// NO PAGE SIZE. GoogleAdsService.search refuses one outright:
//
//   Setting the page size is not supported. Search Responses will have fixed
//   page size of '10000' rows.
//
// It is a 400 on the whole request, not a warning — so sending `pageSize` at
// all meant every run failed. Pagination is unchanged; only the size is
// Google's to decide.
//
// Which makes the ceiling below generous rather than tight: five pages is up
// to fifty thousand leads, and Sky Blue will not see that many this decade.
// It is here to stop a runaway loop, not to ration anything.
const MAX_PAGES = 5;

/**
 * An access token, from the refresh token.
 *
 * Fetched per invocation rather than cached. A scheduled function is a cold
 * process most times it runs, so there is nothing to cache into, and a stale
 * token cached across a deploy is a failure that only shows up an hour later.
 */
export async function accessToken(fetchImpl = fetch) {
  const id = process.env.GOOGLE_ADS_CLIENT_ID;
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_ADS_REFRESH_TOKEN;

  // Named one at a time. "Google auth failed" sends somebody to the OAuth
  // playground; "GOOGLE_ADS_REFRESH_TOKEN is not set" sends them to Netlify.
  const missing = [
    !id && "GOOGLE_ADS_CLIENT_ID",
    !secret && "GOOGLE_ADS_CLIENT_SECRET",
    !refresh && "GOOGLE_ADS_REFRESH_TOKEN",
  ].filter(Boolean);
  if (missing.length) throw new Error(`not set in Netlify: ${missing.join(", ")}`);

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }).toString(),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Google's own words. `invalid_grant` means the refresh token has been
    // revoked or expired, which is a different afternoon from a wrong secret,
    // and the error says which.
    throw new Error(
      `Google refused the refresh token (${res.status}${
        body?.error ? `: ${body.error}` : ""
      })`
    );
  }
  if (!body?.access_token) throw new Error("Google returned no access token");

  return body.access_token;
}

/**
 * The query.
 *
 * FIELD NAMES ARE NOT GUESSED. Every one is from Google's own documented
 * example for this resource. A name that does not exist does not return null
 * — it fails the whole query, so there is no partial answer to misread.
 *
 * `contact_details` is selected whole rather than by subfield, which is also
 * what the documented example does, so a rename inside it does not break the
 * query. It is null when lead_status is WIPED_OUT.
 */
export function leadsQuery(sinceIso) {
  return `
    SELECT
      local_services_lead.resource_name,
      local_services_lead.lead_type,
      local_services_lead.category_id,
      local_services_lead.service_id,
      local_services_lead.contact_details,
      local_services_lead.lead_status,
      local_services_lead.creation_date_time,
      local_services_lead.lead_charged
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${sinceIso}'
    ORDER BY local_services_lead.creation_date_time ASC
  `.trim();
}

/**
 * Google wants 'YYYY-MM-DD HH:MM:SS', not an ISO string with a Z on the end.
 *
 * Passing an ISO string is accepted by some Google APIs and rejected by this
 * one with a message about an invalid date, which reads like the date is
 * wrong rather than the format.
 */
export function asGoogleTime(date) {
  return new Date(date).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Where to start reading.
 *
 * The newest lead already stored, less an overlap — or, on an empty table,
 * far enough back to pick up what already exists. Taking the high-water mark
 * from the data rather than from a stored cursor means there is no second
 * fact to disagree with it.
 */
export function windowStart(latestIso, now = Date.now()) {
  if (!latestIso) return new Date(now - FIRST_RUN_DAYS() * 86400000);
  const latest = Date.parse(latestIso);
  if (!Number.isFinite(latest)) return new Date(now - FIRST_RUN_DAYS() * 86400000);
  return new Date(latest - OVERLAP_HOURS * 3600000);
}

/**
 * One lead, as the database wants it.
 *
 * THE ID COMES FROM THE RESOURCE NAME — customers/{cid}/localServicesLeads/{id}
 * — because that field exists on every GAQL resource and cannot be renamed
 * out from under this. Everything else is read defensively: this payload
 * belongs to somebody else and the surrounding product is mid-migration.
 */
export function asRow(lead) {
  const resource = lead?.resourceName || lead?.resource_name || "";
  const id = String(resource).split("/").pop() || null;

  const contact = lead?.contactDetails || lead?.contact_details || {};

  // Google returns creation_date_time in the ACCOUNT's timezone with no
  // offset. Left as the string Google sent: Postgres parses it, and inventing
  // a timezone here would shift every lead by however wrong the guess is.
  const at = lead?.creationDateTime || lead?.creation_date_time || null;

  return {
    id,
    name: contact.consumerName || contact.consumer_name || null,
    phone: contact.phoneNumber || contact.phone_number || null,
    email: contact.email || null,
    at,
    type: lead?.leadType || lead?.lead_type || null,
    category: lead?.categoryId || lead?.category_id || null,
    service: lead?.serviceId || lead?.service_id || null,
    status: lead?.leadStatus || lead?.lead_status || null,
    // Boolean, and left undefined rather than false when Google did not say.
    // "Not charged" and "not stated" are different, and only one is a number
    // somebody adds up.
    ...(typeof (lead?.leadCharged ?? lead?.lead_charged) === "boolean"
      ? { charged: lead.leadCharged ?? lead.lead_charged }
      : {}),
    detail: describeLead(lead),
  };
}

/**
 * The sentence that goes on the timeline.
 *
 * Google does not send the customer's message on the lead itself — that lives
 * on local_services_lead_conversation, which is a second query and not built
 * yet. So this says what IS known: how they got in touch and what they were
 * looking for. "Google lead" alone on a timeline tells somebody nothing they
 * cannot see from the badge.
 */
export function describeLead(lead) {
  const type = String(lead?.leadType || lead?.lead_type || "").toUpperCase();
  const how =
    type === "PHONE_CALL"
      ? "Called through Google"
      : type === "MESSAGE"
        ? "Messaged through Google"
        : type === "BOOKING"
          ? "Booked through Google"
          : "Google Local Services lead";

  const category = lead?.categoryId || lead?.category_id;
  // xcat:service_area_business_window_cleaning → "window cleaning". The raw id
  // is unreadable on a timeline and the tidy form is still Google's word.
  const tidy = category
    ? String(category).replace(/^xcat:/, "").replace(/^service_area_business_/, "").replace(/_/g, " ")
    : null;

  return tidy ? `${how} — ${tidy}` : how;
}

/**
 * One page of leads.
 */
export async function fetchPage({ token, customerId, query, pageToken, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    headers["developer-token"] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  }
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  const res = await fetchImpl(
    `https://googleads.googleapis.com/${API_VERSION()}/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        ...(pageToken ? { pageToken } : {}),
      }),
    }
  );

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Google buries the useful sentence several levels down. Dug out rather
    // than printing the envelope, because the message is the whole diagnosis:
    // a bad field name, a customer id that is not reachable, a missing scope.
    const detail =
      body?.error?.details?.[0]?.errors?.[0]?.message ||
      body?.error?.message ||
      JSON.stringify(body).slice(0, 300);
    throw new Error(`Google Ads refused the query (${res.status}): ${detail}`);
  }

  return {
    rows: Array.isArray(body?.results) ? body.results : [],
    next: body?.nextPageToken || null,
  };
}

export default async (req) => {
  // Netlify's scheduler sends a POST. A GET is somebody in a browser, and the
  // run writes to customer records, so it is not something to do by accident.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Digits only. The id is shown as 146-936-2727 everywhere in Google's own
  // interface and the API rejects the dashes, which is a 404 that reads as
  // "no such account" rather than as a formatting problem.
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/\D/g, "");
  if (!customerId) {
    throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set in Netlify");
  }

  try {
    const latest = await rpc("latest_google_lead_at", {});
    const since = windowStart(latest);
    const query = leadsQuery(asGoogleTime(since));

    const token = await accessToken();

    let pageToken = null;
    let pages = 0;
    let scanned = 0;
    let imported = 0;

    do {
      const { rows, next } = await fetchPage({ token, customerId, query, pageToken });
      scanned += rows.length;

      if (rows.length) {
        const added = await rpc("record_google_leads", {
          p_rows: rows.map((r) => asRow(r.localServicesLead || r.local_services_lead || r)),
        });
        imported += Number(added) || 0;
      }

      pageToken = next;
      pages += 1;
    } while (pageToken && pages < MAX_PAGES);

    const more = Boolean(pageToken);

    // One line per run, always — including the quiet ones. An empty log and a
    // run that never happened look identical, and that mistake has been made
    // three times in this codebase already.
    console.log("[google-leads] ran", {
      since: since.toISOString(),
      // "first run" is worth seeing: it explains a large number without
      // anybody having to work out why.
      from: latest ? "the newest lead we had" : "first run",
      scanned,
      imported,
      pages,
      more,
    });

    return new Response(JSON.stringify({ ok: true, scanned, imported, more }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // THROWN, not returned, and that is the repo's convention for a scheduled
    // function — see ack-leads.mjs. A failure here shows as a failed
    // invocation in the Netlify dashboard; a 200 with an error field inside it
    // shows as a successful run that found nothing, forever, and nobody ever
    // opens the body of a scheduled invocation that says it succeeded.
    console.error("[google-leads] failed", err);
    throw err;
  }
};

export const config = {
  // NO `path`. This writes to customer records and nothing outside Netlify's
  // scheduler should be able to start it. The other scheduled sweep in this
  // codebase is declared the same way.
  //
  // Hourly at seven past, not on the hour. LSA leads are people waiting for a
  // call back, so a nightly run would mean somebody rings at 9am about a lead
  // from 10am yesterday — by which time they have called the next window
  // cleaner on the list. The offset keeps it off the minute every other
  // scheduled job in the world runs on.
  schedule: "7 * * * *",
};
