// Renders both notification emails and photographs them.
//
// The assertions in verify/notify.mjs prove the right STRINGS are present.
// They cannot tell you the thing looks like a broken table in an inbox, and
// these two emails are the only part of the CRM that is read somewhere the
// CRM's own stylesheet never reaches.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { quoteSentNotification, quoteAcceptedNotification } from "../netlify/lib/notify.mjs";

process.env.PUBLIC_URL = "https://crm.skybluecleaningco.com";

const pages = [
  ["sent", quoteSentNotification({
    channel: "text",
    customerName: "Jane O'Brien",
    customerPhone: "(541) 555-0134",
    address: "412 NW Monroe Ave, Corvallis",
    serviceKeys: ["residential-window-washing", "gutter-cleaning"],
    amount: 450,
    note: "Ladder access round the back. Dog in the yard.",
    link: "https://crm.skybluecleaningco.com/q/" + "a".repeat(64),
    expiresAt: "October 18",
    sentByName: "Trenton",
    leadId: "lead-1",
  })],
  ["accepted", quoteAcceptedNotification({
    customerName: "Jane O'Brien",
    address: "412 NW Monroe Ave, Corvallis",
    serviceKeys: ["residential-window-washing", "gutter-cleaning"],
    amount: 450,
    sentByName: "Trenton",
    leadId: "lead-1",
  })],
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [name, { subject, html }] of pages) {
  const file = `verify/.notify-${name}.html`;
  // Wrapped the way a mail client presents it: a plain page, a grey backdrop,
  // and the subject line above, because the subject is half the deliverable.
  writeFileSync(file, `<!doctype html><meta charset="utf-8">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
<p style="max-width:520px;margin:0 auto 14px;font-size:0.8rem;color:#64748b;">Subject: <strong style="color:#0f172a;">${subject.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</strong></p>
${html}</body>`);
  const page = await browser.newPage({ viewport: { width: 620, height: 900 } });
  await page.goto("file://" + process.cwd() + "/" + file);
  await page.screenshot({ path: `verify/.notify-${name}.png`, fullPage: true });
  await page.close();
  console.log(`wrote verify/.notify-${name}.png`);
}
await browser.close();
