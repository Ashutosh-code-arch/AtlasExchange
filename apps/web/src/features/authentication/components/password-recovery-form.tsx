import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";
import { HumanVerificationWidget } from "./human-verification-widget";

export interface PasswordRecoveryFormProps {
  readonly onReturnToSignIn: () => void;
  readonly humanVerification?:
    | Readonly<{ enabled: false }>
    | Readonly<{ enabled: true; provider: "turnstile"; siteKey: string }>;
}

function recoveryErrorMessage(error: unknown): string {
  if (!(error instanceof ApiHttpError)) {
    return "Password recovery is unavailable. Try again.";
  }
  switch (error.code) {
    case "VALIDATION_FAILED":
      return "Enter a valid email address.";
    case "RATE_LIMITED":
      return "Too many recovery attempts. Try again later.";
    case "HUMAN_VERIFICATION_FAILED":
      return "Complete the human verification again.";
    case "HUMAN_VERIFICATION_UNAVAILABLE":
      return "Human verification is temporarily unavailable. Try again.";
    default:
      return "Password recovery is unavailable. Try again.";
  }
}

export function PasswordRecoveryForm({
  onReturnToSignIn,
  humanVerification = { enabled: false },
}: PasswordRecoveryFormProps): React.JSX.Element {
  const { requestPasswordReset } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [humanVerificationToken, setHumanVerificationToken] = useState<string | null>(null);
  const [humanVerificationResetKey, setHumanVerificationResetKey] = useState(0);

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
    void requestPasswordReset({
      email,
      ...(humanVerificationToken === null ? {} : { humanVerificationToken }),
    })
      .then(() => {
        if (mountedRef.current) {
          setEmail("");
          setAccepted(true);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setErrorMessage(recoveryErrorMessage(error));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSubmitting(false);
          if (humanVerification.enabled) {
            setHumanVerificationToken(null);
            setHumanVerificationResetKey((value) => value + 1);
          }
        }
      });
  };

  if (accepted) {
    return (
      <div className="recovery-accepted">
        <div role="status">
          <strong>Check your email</strong>
          <p>
            If this address is eligible for recovery, Atlas will send password-reset instructions
            shortly.
          </p>
        </div>
        <button className="text-button" type="button" onClick={onReturnToSignIn}>
          Return to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="password-recovery-flow">
      <form className="login-form password-recovery-form" onSubmit={handleSubmit}>
        <div className="login-form__field">
          <label htmlFor="recovery-email">Email</label>
          <input
            id="recovery-email"
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
        {humanVerification.enabled ? (
          <HumanVerificationWidget
            action="forgot_password"
            siteKey={humanVerification.siteKey}
            resetKey={humanVerificationResetKey}
            onTokenChange={setHumanVerificationToken}
          />
        ) : null}
        <button
          className="login-form__submit"
          type="submit"
          disabled={submitting || (humanVerification.enabled && humanVerificationToken === null)}
        >
          {submitting ? "Requesting reset…" : "Request password reset"}
        </button>
        <p className="login-form__error" role="alert" aria-live="polite">
          {errorMessage}
        </p>
      </form>
      <div className="authentication-mode-switch">
        <span>Remembered your password?</span>
        <button className="text-button" type="button" onClick={onReturnToSignIn}>
          Return to sign in
        </button>
      </div>
    </div>
  );
}
