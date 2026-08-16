// netlify/functions/send-receipt.mjs
//
// Emails a branded Sky Blue receipt for a job that was PAID in the field
// (cash, check, or Square reader). This is a receipt (confirmation of
// payment), NOT a bill — no payment button.
//
// Required Netlify environment variables (server-only, no VITE_ prefix):
//   RESEND_API_KEY   — from resend.com dashboard
//   RECEIPT_FROM     — e.g. "Sky Blue Cleaning Co. <receipts@skybluecleaningco.com>"
//                      (the domain must be verified in Resend)

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

function money(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

const METHOD_LABEL = {
  cash: "Cash",
  check: "Check",
  square: "Card (Square)",
};

function receiptHtml({ customerName, amount, method, description, date, address }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
    <div style="background:#2563eb;padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#ffffff;margin:0;font-size:1.4rem;">Sky Blue Cleaning Co.</h1>
      <p style="color:#dbeafe;margin:6px 0 0;font-size:0.9rem;">Payment receipt</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:24px;">
      <p style="margin:0 0 16px;">Hi ${customerName || "there"}, thanks for your business! This confirms your payment.</p>
      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        <tr><td style="padding:8px 0;color:#64748b;">Service</td><td style="padding:8px 0;text-align:right;">${description || "Window cleaning"}</td></tr>
        ${address ? `<tr><td style="padding:8px 0;color:#64748b;">Address</td><td style="padding:8px 0;text-align:right;">${address}</td></tr>` : ""}
        <tr><td style="padding:8px 0;color:#64748b;">Date</td><td style="padding:8px 0;text-align:right;">${date}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;">Payment method</td><td style="padding:8px 0;text-align:right;">${METHOD_LABEL[method] || method}</td></tr>
        <tr><td style="padding:14px 0 0;font-weight:700;font-size:1.1rem;">Total paid</td><td style="padding:14px 0 0;text-align:right;font-weight:700;font-size:1.1rem;color:#16a34a;">${money(amount)}</td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:0.85rem;color:#64748b;">
        Family-owned. No fake stats. Just clean.<br/>
        Questions? Just reply to this email.
      </p>
    </div>
  </div>`;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await verifyUser(req))) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let p;
  try {
    p = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { customerName, customerEmail, amount, method, description, address } = p;
  if (!customerEmail || !amount || !method) {
    return Response.json(
      { error: "customerEmail, amount, and method are required" },
      { status: 400 }
    );
  }

  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RECEIPT_FROM,
        to: [customerEmail],
        subject: `Your Sky Blue Cleaning receipt — ${money(amount)}`,
        html: receiptHtml({ customerName, amount, method, description, date, address }),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || "Resend error");
    }
    return Response.json({ id: data.id, sent: true });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/send-receipt",
};
