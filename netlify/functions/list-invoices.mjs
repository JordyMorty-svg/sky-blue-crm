// netlify/functions/list-invoices.mjs
//
// What invoices does Square have?
//
// This exists so nobody has to copy an invoice id by hand again.
//
// Until now the ONLY way an invoice id reached a job was the completion flow
// creating a brand new one. So when Hayden sent an invoice from the Square
// app himself, there was no way to tell the CRM about it — and on 30 Sep the
// id got typed straight into the Supabase table editor, which logged three
// "Invoice emailed to the customer" rows for one invoice the CRM had never
// sent. Fixing the wording (db/invoice-truth.sql) stopped the history lying.
// This is the other half: a door that isn't the database.
//
// Square's own numbering is what people recognise — "#000011" is on the
// email the customer got — so that is what the picker shows, next to the
// customer, the amount and the status.
//
// Required Netlify environment variables (NO VITE_ prefix — server-only):
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV
// (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are already set here.)

const SQUARE_VERSION = "2026-01-22";

// Enough to cover "the one Hayden sent this week" without pulling a year of
// history down a phone connection on a driveway.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

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

// Same reduction get-invoice.mjs makes, and deliberately the same list:
// two endpoints disagreeing about whether an invoice is settled would be a
// bug nobody could see. PARTIALLY_PAID is NOT settled — a deposit is not
// payment, and counting it as one overstates income.
const SETTLED = ["PAID", "REFUNDED", "PARTIALLY_REFUNDED"];

// A draft has never been sent to anybody. Showing one in a list headed
// "invoices Square has sent" would invite attaching it to a job and
// believing the customer had been billed.
const NOT_SENT = ["DRAFT"];

/** Whatever Square can tell us about who this was for. */
function recipientName(invoice) {
  const r = invoice.primary_recipient || {};
  const name = [r.given_name, r.family_name].filter(Boolean).join(" ").trim();
  return name || r.company_name || r.email_address || null;
}

/** The total asked for, in dollars, across every payment request. */
function requestedAmount(invoice) {
  const cents = (invoice.payment_requests || []).reduce(
    (sum, r) => sum + Number(r.computed_amount_money?.amount || 0),
    0
  );
  return cents / 100;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!(await verifyUser(req))) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) {
    // Named plainly rather than returning an empty list. "No invoices
    // found" for a missing environment variable is the kind of answer that
    // sends somebody back to the table editor.
    return Response.json(
      { error: "SQUARE_LOCATION_ID is not set on this deploy." },
      { status: 500 }
    );
  }

  let payload = {};
  try {
    payload = await req.json();
  } catch {
    // An empty body is fine — it means "the default page".
  }

  const limit = Math.min(Number(payload.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  try {
    const data = await square("/v2/invoices/search", "POST", {
      query: {
        filter: { location_ids: [locationId] },
        // Newest first: the one somebody is looking for was almost always
        // sent in the last day or two.
        sort: { field: "INVOICE_SORT_DATE", order: "DESC" },
      },
      limit,
      cursor: payload.cursor || undefined,
    });

    const invoices = (data.invoices || [])
      .filter((inv) => !NOT_SENT.includes(inv.status))
      .map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number || null,
        status: inv.status,
        paid: SETTLED.includes(inv.status),
        amount: requestedAmount(inv),
        customerName: recipientName(inv),
        publicUrl: inv.public_url || null,
        createdAt: inv.created_at || null,
        title: inv.title || null,
      }));

    return Response.json({ invoices, cursor: data.cursor || null });
  } catch (err) {
    console.error("[list-invoices]", err);
    return Response.json({ error: err.message }, { status: err.status || 500 });
  }
};

export const config = {
  path: "/api/list-invoices",
};
