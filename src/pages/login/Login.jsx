import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../../supabaseClient";
import "./Login.css";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { state } = useLocation();

  // Where ProtectedRoute was trying to send them before it found no
  // session. The search string has to come too — a Square tap returns to
  // /pos-return?data=… and the transaction id lives entirely in there.
  const from = state?.from
    ? `${state.from.pathname}${state.from.search || ""}`
    : "/leads";

  // Landing here straight off a card payment isn't a page anyone chose to
  // visit, so explain why they're being asked to sign in.
  const returningFromPayment = state?.from?.pathname === "/pos-return";

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setBusy(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setBusy(false);

    if (signInError) {
      setError("That email and password don't match. Try again.");
      return;
    }

    // Success — resume whatever they were doing, or the leads board if
    // they came to /login directly.
    navigate(from, { replace: true });
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <span className="login__brand-name">
            Sky Blue Cleaning <span className="login__brand-accent">CRM</span>
          </span>
        </div>

        <h1 className="login__title">Sign in</h1>
        {returningFromPayment ? (
          <p className="login__subtitle login__subtitle--payment">
            The card was charged. Sign in to finish recording the job — the
            payment is safe either way, and you won't be asked again on this
            browser.
          </p>
        ) : (
          <p className="login__subtitle">Team access portal</p>
        )}

        <form onSubmit={handleLogin} className="login__form">
          <label className="login__label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            className="login__input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />

          <label className="login__label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="login__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {error && <p className="login__error">{error}</p>}

          <button type="submit" className="login__button" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}