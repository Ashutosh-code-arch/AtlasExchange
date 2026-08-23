import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";

export interface RegistrationFormProps {
  readonly onReturnToSignIn: () => void;
}

function registrationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiHttpError)) {
    return "Account creation is unavailable. Try again.";
  }
  switch (error.code) {
    case "VALIDATION_FAILED":
      return "Use a valid email and a password that meets the requirements.";
    case "RATE_LIMITED":
      return "Too many registration attempts. Try again later.";
    default:
      return "Account creation is unavailable. Try again.";
  }
}

export function RegistrationForm({ onReturnToSignIn }: RegistrationFormProps): React.JSX.Element {
  const { register } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
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
    if (password !== passwordConfirmation) {
      setErrorMessage("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    void register({ email, password })
      .then(() => {
        if (mountedRef.current) {
          setPassword("");
          setPasswordConfirmation("");
          setAccepted(true);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setErrorMessage(registrationErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSubmitting(false);
        }
      });
  };

  if (accepted) {
    return (
      <div className="registration-accepted">
        <div role="status">
          <strong>Check your email</strong>
          <p>
            If this address can be registered, Atlas will send verification instructions shortly.
          </p>
        </div>
        <button className="text-button" type="button" onClick={onReturnToSignIn}>
          Return to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="registration-flow">
      <form className="login-form registration-form" onSubmit={handleSubmit}>
        <div className="login-form__field">
          <label htmlFor="registration-email">Email</label>
          <input
            id="registration-email"
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
          <label htmlFor="registration-password">Password</label>
          <input
            id="registration-password"
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
          <label htmlFor="registration-password-confirmation">Confirm password</label>
          <input
            id="registration-password-confirmation"
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
        <button className="login-form__submit" type="submit" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
        <p className="registration-form__guidance">
          Use 15–128 characters. Atlas also rejects known compromised passwords.
        </p>
        <p className="login-form__error" role="alert" aria-live="polite">
          {errorMessage}
        </p>
      </form>
      <div className="authentication-mode-switch">
        <span>Already registered?</span>
        <button className="text-button" type="button" onClick={onReturnToSignIn}>
          Return to sign in
        </button>
      </div>
    </div>
  );
}
