import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";

export interface PasswordResetProps {
  readonly token: string | undefined;
}

function resetErrorMessage(error: unknown): string {
  if (!(error instanceof ApiHttpError)) {
    return "Password reset is unavailable. Try again.";
  }
  switch (error.code) {
    case "VALIDATION_FAILED":
      return "This link is invalid or expired, or the new password cannot be accepted.";
    case "RATE_LIMITED":
      return "Too many password-reset attempts. Try again later.";
    default:
      return "Password reset is unavailable. Try again.";
  }
}

export function PasswordReset({ token }: PasswordResetProps): React.JSX.Element {
  const { resetPassword } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (token === undefined || submitting) {
      return;
    }
    if (password !== passwordConfirmation) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    void resetPassword({ token, password })
      .then(() => {
        if (mountedRef.current) {
          setPassword("");
          setPasswordConfirmation("");
          setCompleted(true);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setPassword("");
          setPasswordConfirmation("");
          setErrorMessage(resetErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSubmitting(false);
        }
      });
  };

  if (token === undefined) {
    return (
      <div className="password-reset-card">
        <div role="alert">
          <p className="eyebrow">Password reset</p>
          <h1>Link unavailable</h1>
          <p>This password-reset link is missing its one-time capability.</p>
        </div>
        <a className="primary-button" href="/">
          Request a new link
        </a>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="password-reset-card">
        <div role="status">
          <p className="eyebrow">Password reset</p>
          <h1>Password replaced</h1>
          <p>Your sessions have been revoked. Sign in again with your new password.</p>
        </div>
        <a className="primary-button" href="/">
          Continue to sign in
        </a>
      </div>
    );
  }

  return (
    <div className="password-reset-card">
      <p className="eyebrow">Password reset</p>
      <h1>Choose a new password</h1>
      <p>This one-time capability will be consumed only after Atlas accepts the replacement.</p>
      <form className="password-reset-form" onSubmit={handleSubmit}>
        <div className="login-form__field">
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={15}
            maxLength={128}
            required
            disabled={submitting}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </div>
        <div className="login-form__field">
          <label htmlFor="reset-password-confirmation">Confirm new password</label>
          <input
            id="reset-password-confirmation"
            name="passwordConfirmation"
            type="password"
            autoComplete="new-password"
            minLength={15}
            maxLength={128}
            required
            disabled={submitting}
            value={passwordConfirmation}
            onChange={(event) => setPasswordConfirmation(event.currentTarget.value)}
          />
        </div>
        <p className="password-reset-form__guidance">
          Use 15–128 characters. Atlas also rejects known compromised passwords.
        </p>
        <p className="password-reset-form__error" role="alert" aria-live="polite">
          {errorMessage}
        </p>
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Replacing password…" : "Replace password"}
        </button>
      </form>
    </div>
  );
}
