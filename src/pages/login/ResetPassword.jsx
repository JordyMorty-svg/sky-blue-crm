import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../supabaseClient";
import { useAuth } from "../../context/useAuth";
import "./Login.css";

/**
 * Where a password reset email lands.
 *
 * Supabase's recovery link carries its tokens in the URL fragment. The
 * client parses that on load and establishes a real session, which is why
 * this page can call updateUser without asking for the old password — the
 * link itself is the proof of identity.
 *
 * Deliberately NOT behind ProtectedRoute. A recovery session would satisfy
 * it, but an expired or already-used link would not, and bouncing someone
 * to a sign-in form they can't get past is the least helpful possible
 * response to "my reset link didn't work". Here they get told what
 * happened and how to get another one.
 */

// Supabase's own floor is 6. Eight is not much to ask of a password
// somebody will save in their phone's keychain and never type again.
const MIN_LENGTH = 8;

export default function ResetPassword() {
  const navigate = useNavigate();
  const { recovery, endRecovery } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(null); // null = still checking
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Two ways the session can arrive, and both have to be handled or the
  // page is a coin flip. If the client has already parsed the fragment by
  // the time this mounts, getSession returns it immediately; if it hasn't,
  // nothing exists yet and the PASSWORD_RECOVERY event lands a moment
  // later. Listening for only one of them fails intermittently.
  useEffect(() => {
    let cancelled = false;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === "PASSWORD_RECOVERY" || session) setReady(true);
    });

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      // Only conclude "no link" when there is genuinely no session —
      // setReady(true) from the listener must not be undone by this.
      setReady((cur) => (cur === true ? true : recovery || !!data.session));
    })();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // `recovery` is read once, to answer "did a reset link bring me here"
    // at mount. Re-running the effect when it changes would tear down and
    // rebuild the auth listener mid-flow for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Those two don't match.");
      return;
    }

    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (updateError) {
      console.error(updateError);
      setError(updateError.message || "Couldn't set that password.");
      return;
    }
    // Releases the gate in App — otherwise every route keeps redirecting
    // back here and "Go to the CRM" does nothing.
    endRecovery();
    setDone(true);
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <span className="login__brand-name">
            Sky Blue Cleaning <span className="login__brand-accent">CRM</span>
          </span>
        </div>

        {ready === null && (
          <>
            <h1 className="login__title">One moment</h1>
            <p className="login__subtitle">Checking your link…</p>
          </>
        )}

        {ready === false && (
          <>
            <h1 className="login__title">That link has expired</h1>
            <p className="login__subtitle">
              Reset links are single-use and don&rsquo;t last long. Ask Jordan
              or Hayden to send a new one, or use{" "}
              <b>Forgot your password?</b> on the sign-in page.
            </p>
            <button
              type="button"
              className="login__button"
              onClick={() => navigate("/login", { replace: true })}
            >
              Back to sign in
            </button>
          </>
        )}

        {ready === true && done && (
          <>
            <h1 className="login__title">Password set</h1>
            <p className="login__subtitle">
              You&rsquo;re signed in. This is the password you&rsquo;ll use from
              now on.
            </p>
            <button
              type="button"
              className="login__button"
              onClick={() => navigate("/leads", { replace: true })}
            >
              Go to the CRM
            </button>
          </>
        )}

        {ready === true && !done && (
          <>
            <h1 className="login__title">Choose a password</h1>
            <p className="login__subtitle">
              Only you will know this one.
            </p>

            <form onSubmit={handleSubmit} className="login__form">
              <label className="login__label" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                type="password"
                className="login__input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                // new-password, not current-password: this is what tells a
                // password manager to offer to generate and save one rather
                // than autofilling something that no longer works.
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
                autoFocus
              />

              <label className="login__label" htmlFor="confirm">
                Type it again
              </label>
              <input
                id="confirm"
                type="password"
                className="login__input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />

              {error && <p className="login__error">{error}</p>}

              <button type="submit" className="login__button" disabled={busy}>
                {busy ? "Saving…" : "Save password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
