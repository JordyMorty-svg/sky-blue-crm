// netlify/lib/whoIs.mjs
//
// Who is calling this endpoint, by their Supabase user id.
//
// Lived inside send-text.mjs, because that was the only endpoint a signed-in
// person called directly. backfill-texts.mjs is the second, and a second
// copy of an authentication check is how one of them stops being maintained
// — the same argument that moved the webhook signature into webhooks.mjs.
//
// THE ID, NOT JUST A YES/NO. A message typed by a person records who typed
// it; that is what puts "Hayden" under the bubble in the thread instead of
// nothing, and it is the difference between reading a conversation and
// reading a transcript with one speaker missing.
//
// Null means "not signed in" and the caller must answer 401. There is no
// third state on purpose: an endpoint that can reach Quo's API with the
// workspace key has no business guessing.

export async function whoIs(req) {
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return null;

  const res = await fetch(`${process.env.VITE_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;

  const user = await res.json().catch(() => null);
  return user?.id || null;
}
