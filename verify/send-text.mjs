// The send endpoint behind the thread composer: node verify/send-text.mjs
//
// /api/send-text is the one place a person can type arbitrary words and have
// them leave the building as a text message. Everything else in this system
// sends wording the codebase chose, to a list the database picked.
//
// WHICH MAKES THE RULES HERE THE WHOLE POINT. The endpoint must be unable
// to become a second way to send a text — one with none of the protections
// the first way has. There are four that matter and they are not equally
// expensive to get wrong:
//
//   the opt-out       — a text to somebody who replied STOP is a carrier
//                       violation and the number's reputation, not just an
//                       annoyance
//   who is calling    — an unauthenticated send endpoint is an open SMS
//                       relay on the business's own A2P-registered number
//   the mode switch   — SMS_MODE=off has to mean off, including here
//   the claim         — so a double-click is one text, not two
//
// None of those are implemented here, deliberately: they all live in
// claim_sms() and sendSms(). So most of this file checks that this endpoint
// still DELEGATES rather than deciding, because a copy of a rule is a
// second answer to the same question and it is always the copy that is
// wrong.

import handler, { sendProblem } from "../netlify/functions/send-text.mjs";

let bad = 0;
const chk = (what, pass, detail = "") => {
  if (pass) console.log(`ok    ${what}`);
  else {
    bad++;
    console.log(`FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
  }
};

const { readFileSync } = await import("node:fs");
const raw = readFileSync("netlify/functions/send-text.mjs", "utf8");

// Comments stripped before anything is matched against the source. A check
// that finds the word it is looking for inside the comment explaining the
// rule reports the opposite of the truth, and it reports it green.
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

console.log("\n-- nobody sends a text without saying who they are --\n");

{
  const whoIs = src.indexOf("const userId = await whoIs(req)");
  const refuse = src.indexOf("Not signed in.");
  const send = src.indexOf("await sendSms({");

  chk("THE POINT: the caller is identified before anything is sent",
    whoIs > -1 && send > -1 && whoIs < send,
    "this endpoint can text any number in the United States from the " +
      "business's own A2P-registered number");

  chk("...and an unidentified one is refused, not merely unnamed",
    refuse > -1 && refuse < send && /status: 401/.test(src));

  // The id, not a boolean. A message typed by a person records who typed
  // it — that is what puts a name under the bubble in the thread instead of
  // nothing, and the difference between reading a conversation and reading
  // a transcript with one speaker missing.
  chk("the sender is recorded, not just allowed",
    /sentBy:\s*userId/.test(src));
}

console.log("\n-- it decides nothing about whether the text may go --\n");

{
  const body = src.slice(src.indexOf("export default async (req)"));

  // Every one of these would be a second implementation of a rule that
  // already exists in SQL, reachable only through this door, and therefore
  // the one that is wrong when they disagree.
  chk("THE POINT: it does not check the opt-out itself",
    !/opted?[_ ]?out|\bSTOP\b/.test(body.replace(/sendProblem|case "opted_out"[\s\S]{0,200}?;/g, "")),
    "sb_sms_opted_out() is checked inside claim_sms(), in the same " +
      "transaction as the insert, and has no override anywhere");

  chk("...nor the quiet hours",
    !/quiet.*(hour|now)\s*\(|getHours|new Date\(\)\.getHours/i.test(body));

  chk("...nor whether texting is switched on",
    !/SMS_MODE|smsMode\(/.test(body),
    "sendSms() reads the mode on every path including a button press");

  chk("...nor whether this is a duplicate",
    !/dedupe|already.?sent.{0,20}=|claim_sms/i.test(
      body.replace(/case "already_sent"[\s\S]{0,120}?;/g, "")),
    "the insert IS the claim; a check here would be a race");

  chk("it posts to Quo only through sendSms",
    !/api\.quo|QUO_API_KEY|postToQuo/.test(body),
    "a direct post would skip the claim, the opt-out and the logging at once");
}

console.log("\n-- a person pressed send, at half past eight --\n");

{
  // force: true skips QUIET HOURS and nothing else.
  //
  // Quiet hours exist to stop the CRM starting conversations at 8:45pm.
  // They are not a reason to refuse to let Hayden answer a customer who
  // texted HIM at 8:45pm. The opt-out is enforced in claim_sms() and this
  // argument cannot reach it.
  chk("THE POINT: a reply is forced past quiet hours",
    /force:\s*true/.test(src),
    "otherwise answering a customer in the evening silently does nothing");

  chk("...and the file says what force does and does not skip",
    /force skips QUIET HOURS and nothing else/i.test(raw),
    "the next person to read this has to know the opt-out is not negotiable");
}

console.log("\n-- the message lands on the whole person --\n");

{
  // A person is routinely a lead and a customer at once. A text sent from
  // the lead page carrying only lead_id is invisible to anything reading by
  // customer_id — which includes the contact timeline on their own profile.
  chk("THE POINT: both ids are resolved, not just the one the page had",
    /sms_thread_ids/.test(src));

  // Best-effort. A failure there loses a cross-reference; refusing to send
  // over it would lose the message.
  const resolve = src.indexOf("sms_thread_ids");
  const after = src.slice(resolve, resolve + 600);
  chk("...and a failure to resolve does not stop the text",
    /catch/.test(after) && !/throw/.test(after.slice(after.indexOf("catch"))));
}

console.log("\n-- every refusal says what to do about it --\n");

{
  // "Couldn't send" with no reason is the message that makes somebody press
  // the button four more times.
  const reasons = [
    "opted_out", "sms_off", "preview", "not_configured",
    "no_sms_tables", "bad_number", "empty_body", "quiet_hours", "already_sent",
  ];
  for (const r of reasons) {
    const said = sendProblem(r);
    chk(`${r} is explained`, Boolean(said) && !/^Couldn't send:/.test(said), said);
  }

  chk("THE POINT: an opt-out says what to do instead",
    /call/i.test(sendProblem("opted_out")),
    sendProblem("opted_out"));

  chk("sms_off names the switch rather than the symptom",
    /SMS_MODE/.test(sendProblem("sms_off")), sendProblem("sms_off"));

  // An unknown reason carries the provider's own words through rather than
  // flattening them. The one thing worse than a confusing error is a
  // generic one that hides a specific one.
  chk("an unrecognised reason is passed through, not swallowed",
    sendProblem("Quo: rate limit (429)").includes("429"),
    sendProblem("Quo: rate limit (429)"));

  chk("...and no reason at all still says something",
    Boolean(sendProblem(null)) && Boolean(sendProblem(undefined)));
}

console.log("\n-- a refusal is not a crash --\n");

{
  // 200, not 4xx, for "we decided not to send this".
  //
  // An opt-out is not a client error: the request was perfectly well
  // formed and the answer is no. A 4xx has fetch wrappers and error
  // boundaries treat a correct, expected outcome as a fault, and the thread
  // shows "something went wrong" for the one case where the CRM knows
  // exactly what happened and why.
  const notOk = src.indexOf("if (!result.ok)");
  const tail = src.slice(notOk, notOk + 400);
  chk("THE POINT: a refusal comes back 200 with a reason",
    notOk > -1 && /status: 200/.test(tail) && /reason: result\.reason/.test(tail),
    tail.slice(0, 160));

  chk("...and the thread is told which refusal it was",
    /reason: result\.reason/.test(tail),
    "so the composer can keep the draft for an opt-out and clear it for a send");
}

console.log("\n-- driving the real endpoint --\n");
//
// SOURCE-SCANNING STOPS HERE AND THE HANDLER GETS CALLED.
//
// The checks above read the file, which is the only way to assert "this
// code does NOT do X". It is a poor way to assert that it DOES: neutering
// `if (body.length > MAX_CHARS)` to `if (false)` leaves both the constant
// and the message in the file, so a check looking for either stays green
// while the cap is gone.
//
// Nothing is mocked except the network. SMS_MODE is left at its default of
// "off", so sendSms() returns { ok: false, reason: "sms_off" } before it
// reaches Quo — which means every path below is the real one, right up to
// the point where a text would actually cost money.

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    // sms_thread_ids, through rpc()
    return new Response(JSON.stringify([{ lead_id: null, customer_id: null, phone: null }]),
      { status: 200, headers: { "content-type": "application/json" } });
  };

  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  delete process.env.SMS_MODE;

  const post = (body, auth = "Bearer token") =>
    handler(new Request("https://crm.example/api/send-text", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    }));

  const get = () =>
    handler(new Request("https://crm.example/api/send-text", { method: "GET" }));

  let res = await get();
  chk("GET is refused", res.status === 405, String(res.status));

  res = await post({ phone: "+15415550101", body: "hello" }, "");
  chk("an unsigned request is refused", res.status === 401, String(res.status));

  res = await post({ phone: "+15415550101", body: "   \n  " });
  chk("a box full of whitespace is not a message",
    res.status === 400, String(res.status));

  res = await post({ body: "hello" });
  chk("no number is refused", res.status === 400, String(res.status));

  // Quo rejects anything past 1600 characters outright. Refused here with a
  // sentence somebody can act on, rather than passed through to come back
  // as a provider error — and ten segments is also about forty cents and
  // six separate notifications on the customer's lock screen.
  res = await post({ phone: "+15415550101", body: "x".repeat(1601) });
  let json = await res.json();
  chk("THE POINT: an over-long message is refused",
    res.status === 400, `status ${res.status}`);
  chk("...with the actual number, and what to do",
    /1601/.test(json.error || "") && /1600/.test(json.error || ""),
    json.error);

  res = await post({ phone: "+15415550101", body: "x".repeat(1600) });
  chk("...and exactly at the limit it is not refused",
    res.status === 200, `status ${res.status} — an off-by-one here refuses a legal message`);

  // The refusal path, end to end. SMS_MODE is off, which is the state of
  // every fresh deploy.
  res = await post({ phone: "+15415550101", body: "on my way" });
  json = await res.json();
  chk("THE POINT: a refusal is 200 with a reason and a sentence",
    res.status === 200 && json.ok === false && json.reason === "sms_off"
      && /SMS_MODE/.test(json.error || ""),
    JSON.stringify(json));

  chk("...and no text was posted to Quo",
    !calls.some((u) => /quo|openphone/i.test(u)), calls.join(" "));

  res = await post({ phone: "+15415550101", body: "hi" });
  chk("the caller was identified against Supabase",
    calls.some((u) => u.includes("/auth/v1/user")));

  globalThis.fetch = realFetch;
}

console.log(bad === 0 ? "\nall ok — one door, and it still has all the locks on it\n"
                      : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
