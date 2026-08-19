// netlify/functions/find-pos-payment.mjs
//
// Finds the Square payment for a tap, without needing the callback.
//
// WHY: resolve-pos-payment works from the transaction id Square hands back
// on the callback URL. That callback is a browser redirect, and redirects
// get lost — a killed tab, a flat battery, no signal on a doorstep, or an
// iOS home-screen install where the callback opens a different browser
// altogether. By then the customer's card has already been charged, so a
// lost redirect means money moved and the CRM never found out.
//
// This asks Square instead. Every tap carries a short code in its order
// note (see jobCode in squarePos.js), so the order can be located by
// searching the period since the hand-off started.
//
// Required Netlify environment variables (NO VITE_ prefix — server-only):
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV
// (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are already set here.)

const SQUARE_VERSION = "2026-01-22";

// Orders are searched from the hand-off time, with a little slack — the
// device clock and Square's may not agree to the second.
const CLOCK_SLACK_MS = 5 * 60 * 1000;

function squareBase() {
  return process.env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

async function square(path, method, body) {
  const res = await fetch(squareBase() + path, {
    method,
    headers: {
      "Square-Version": SQUARE_VERSION,
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || res.statusText;
    const err = new Error(`Square ${path}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function verifyUser(req) {
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return false;
  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  return res.ok;
}

// Square puts the POS note in different places depending on platform and
// version — order.note, a line item's note, a tender's note. Rather than
// guess, look at the whole order. The code is distinctive enough
// ("SB-" + 8 hex) that a false positive isn't a realistic worry.
function orderCarriesCode(order, code) {
  try {
    return JSON.stringify(order).includes(code);
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!(await verifyUser(req))) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { code, since } = payload;
  if (!code || !since) {
    return Response.json(
      { error: "code and since are required" },
      { status: 400 }
    );
  }

  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) {
    return Response.json(
      { error: "SQUARE_LOCATION_ID isn't set on the server." },
      { status: 500 }
    );
  }

  const startAt = new Date(new Date(since).getTime() - CLOCK_SLACK_MS);
  if (Number.isNaN(startAt.getTime())) {
    return Response.json({ error: "`since` isn't a valid time" }, { status: 400 });
  }

  try {
    const { orders = [] } = await square("/v2/orders/search", "POST", {
      location_ids: [locationId],
      limit: 200,
      return_entries: false,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt.toISOString() } },
          // OPEN as well as COMPLETED: a tap settles as COMPLETED, but an
          // order caught mid-settlement would otherwise be invisible and
          // read as "no payment yet" when there certainly is one.
          state_filter: { states: ["COMPLETED", "OPEN"] },
        },
        // Square requires the sort field to match the field being filtered
        // on. Newest first so the match is found before the page limit
        // matters on a busy day.
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
    });

    const match = orders.find((o) => orderCarriesCode(o, code));
    if (!match) {
      // Not an error. The usual reason is that the operator backed out of
      // Square without paying, which is a perfectly normal thing to do.
      return Response.json({ found: false, searched: orders.length });
    }

    const paymentIds = (match.tenders || [])
      .map((t) => t.payment_id)
      .filter(Boolean);

    if (paymentIds.length === 0) {
      return Response.json({
        found: false,
        orderId: match.id,
        reason: "order-without-payment",
        searched: orders.length,
      });
    }

    const { payment } = await square(`/v2/payments/${paymentIds[0]}`, "GET");

    return Response.json({
      found: true,
      paymentId: payment.id,
      status: payment.status,
      receiptUrl: payment.receipt_url,
      orderId: match.id,
      amount: Number(payment.amount_money?.amount || 0) / 100,
      squareCustomerId: payment.customer_id || null,
      card: payment.card_details?.card
        ? {
            brand: payment.card_details.card.card_brand,
            last4: payment.card_details.card.last_4,
            expMonth: payment.card_details.card.exp_month,
            expYear: payment.card_details.card.exp_year,
            // No card id on purpose: a tapped card is not stored on file,
            // so there is nothing to charge next time.
          }
        : null,
      splitCount: paymentIds.length,
    });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/find-pos-payment",
};
