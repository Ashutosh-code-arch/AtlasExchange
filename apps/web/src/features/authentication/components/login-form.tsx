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

function resendErrorMessage(error: unknown): string {
  return error instanceof ApiHttpError && error.code === "RATE_LIMITED"
    ? "Too many verification requests. Try again later."
    : "Verification email cannot be requested right now. Try again.";
}

export function LoginForm(): React.JSX.Element {
  const { resendVerification, signIn } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendAccepted, setResendAccepted] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

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
    setVerificationEmail(null);
    setResendAccepted(false);
    setResendError(null);
    void signIn({ email, password })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setPassword("");
          setErrorMessage(loginErrorMessage(error));
          if (error instanceof ApiHttpError && error.code === "ACCOUNT_VERIFICATION_REQUIRED") {
            setVerificationEmail(email);
          }
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSubmitting(false);
        }
      });
  };

  const handleEmailChange = (nextEmail: string): void => {
    setEmail(nextEmail);
    setErrorMessage(null);
    setVerificationEmail(null);
    setResendAccepted(false);
    setResendError(null);
  };

  const handleResend = (): void => {
    if (verificationEmail === null || resending || resendAccepted) {
      return;
    }
    setResending(true);
    setResendError(null);
    void resendVerification({ email: verificationEmail })
      .then(() => {
        if (mountedRef.current) {
          setResendAccepted(true);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setResendError(resendErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setResending(false);
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
          onChange={(event) => handleEmailChange(event.currentTarget.value)}
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
      {verificationEmail === null ? null : (
        <div className="login-form__verification-recovery">
          {resendAccepted ? (
            <p role="status">
              If this address is eligible, Atlas will send new verification instructions shortly.
            </p>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={resending}
              onClick={handleResend}
            >
              {resending ? "Requesting verification…" : "Resend verification email"}
            </button>
          )}
          {resendError === null ? null : (
            <p className="login-form__resend-error" role="alert">
              {resendError}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
