// netlify/functions/email-opt-out.mjs
//
// The unsubscribe link at the bottom of a follow-up email.
//
// Public by design — the whole point is that it works for someone who has
// no login and is mildly annoyed. What stands in for auth is a signature
// over the customer id, so the link only opts out the person it was mailed
// to. Without it, anyone holding a list of customer ids could unsubscribe
// the whole book.
//
// GET  shows a confirmation page. It does NOT opt anybody out, because
//      corporate mail scanners and link previewers fetch every URL in an
//      email — a GET that changed something would unsubscribe customers
//      who never clicked anything.
// POST does the work. That covers both the button on that page and the
//      one-click unsubscribe Gmail and Outlook show in their own UI
//      (RFC 8058), which is why the email sends List-Unsubscribe-Post.

import crypto from "node:crypto";
import { unsubToken } from "../lib/followUps.mjs";

function validToken(customerId, token) {
  const expected = unsubToken(customerId);
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function page(title, body) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"/>
     <meta name="viewport" content="width=device-width,initial-scale=1"/>
     <title>${title} — Sky Blue Cleaning Co.</title></head>
     <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;margin:0;padding:40px 20px;color:#0f172a;">
       <div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
         <h1 style="margin:0 0 12px;font-size:1.25rem;">${title}</h1>
         ${body}
       </div>
     </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export default async (req) => {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("c");
  const token = url.searchParams.get("t");

  if (!customerId || !validToken(customerId, token)) {
    return page(
      "That link didn't work",
      `<p style="margin:0;line-height:1.55;color:#475569;">This unsubscribe link looks
       incomplete or has expired. Reply to any of our emails and we'll take you off
       the list by hand.</p>`
    );
  }

  if (req.method === "GET") {
    return page(
      "Unsubscribe from follow-up emails",
      `<p style="margin:0 0 20px;line-height:1.55;color:#475569;">
         You'll stop getting "how did we do?" emails after a clean. You'll still
         get receipts and appointment details — those aren't marketing.
       </p>
       <form method="POST">
         <button type="submit" style="background:#2563eb;color:#fff;border:none;border-radius:999px;padding:13px 26px;font-size:1rem;font-weight:700;cursor:pointer;">
           Yes, unsubscribe me
         </button>
       </form>`
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const res = await fetch(`${base}/rest/v1/rpc/record_email_opt_out`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_customer_id: customerId }),
    });
    if (!res.ok) throw new Error(await res.text());

    return page(
      "Done — you're unsubscribed",
      `<p style="margin:0;line-height:1.55;color:#475569;">
         We won't send you any more follow-up emails. Thanks for having us out,
         and if you ever need the windows done again you know where we are.
       </p>`
    );
  } catch (err) {
    console.error("[opt-out] failed", err);
    return page(
      "Something went wrong",
      `<p style="margin:0;line-height:1.55;color:#475569;">
         We couldn't record that just now. Reply to any of our emails and we'll
         take you off the list by hand.
       </p>`
    );
  }
};

export const config = {
  path: "/api/email-opt-out",
};
