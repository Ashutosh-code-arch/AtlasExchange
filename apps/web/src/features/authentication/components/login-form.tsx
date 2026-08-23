import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof ApiHttpError)) {
    return "Sign in is unavailable. Try again.";
  }
  switch (error.code) {
    case "AUTHENTICATION_FAILED":
      return "Email or password is incorrect.";
    case "ACCOUNT_VERIFICATION_REQUIRED":
      return "Verify your email before signing in.";
    case "ACCOUNT_UNAVAILABLE":
      return "This account is currently unavailable.";
    case "RATE_LIMITED":
      return "Too many sign-in attempts. Try again later.";
    default:
      return "Sign in is unavailable. Try again.";
  }
}

export function LoginForm(): React.JSX.Element {
  const { signIn } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    void signIn({ email, password })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setErrorMessage(loginErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSubmitting(false);
        }
      });
  };

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <div className="login-form__field">
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          maxLength={254}
          required
          disabled={submitting}
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </div>
      <div className="login-form__field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          required
          disabled={submitting}
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
      </div>
      <button className="login-form__submit" type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="login-form__error" role="alert" aria-live="polite">
        {errorMessage}
      </p>
    </form>
  );
}
