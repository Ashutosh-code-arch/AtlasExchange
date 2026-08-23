import { useCallback, useEffect, useRef, useState } from "react";
import { ZodError } from "zod";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../session/use-authentication-session";

export interface EmailVerificationProps {
  readonly token: string | undefined;
}

type VerificationView = "verifying" | "verified" | "invalid" | "unavailable";

function verificationFailureView(
  error: unknown,
): Exclude<VerificationView, "verifying" | "verified"> {
  return error instanceof ZodError ||
    (error instanceof ApiHttpError && error.status === 400 && error.code === "VALIDATION_FAILED")
    ? "invalid"
    : "unavailable";
}

export function EmailVerification({ token }: EmailVerificationProps): React.JSX.Element {
  const { state: sessionState, verifyEmail } = useAuthenticationSession();
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const [view, setView] = useState<VerificationView>(token === undefined ? "invalid" : "verifying");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runVerification = useCallback((): void => {
    if (token === undefined) {
      setView("invalid");
      return;
    }
    setView("verifying");
    void verifyEmail(token)
      .then(() => {
        if (mountedRef.current) {
          setView("verified");
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setView(verificationFailureView(error));
        }
      });
  }, [token, verifyEmail]);

  useEffect(() => {
    if (startedRef.current || sessionState.status === "checking") {
      return;
    }
    startedRef.current = true;
    runVerification();
  }, [runVerification, sessionState.status]);

  if (view === "verifying") {
    return (
      <div className="verification-card" aria-live="polite">
        <p className="eyebrow">Email verification</p>
        <h1>Verifying your link</h1>
        <p>Atlas is confirming this one-time verification capability.</p>
      </div>
    );
  }

  if (view === "verified") {
    return (
      <div className="verification-card">
        <div role="status">
          <p className="eyebrow">Email verification</p>
          <h1>Email verified</h1>
          <p>Your Atlas account is ready. You can now sign in.</p>
        </div>
        <a className="primary-button" href="/">
          Continue to sign in
        </a>
      </div>
    );
  }

  if (view === "invalid") {
    return (
      <div className="verification-card">
        <div role="alert">
          <p className="eyebrow">Email verification</p>
          <h1>Link unavailable</h1>
          <p>This verification link is invalid, expired, or has already been used.</p>
        </div>
        <a className="primary-button" href="/">
          Return to Atlas
        </a>
      </div>
    );
  }

  return (
    <div className="verification-card">
      <div role="alert">
        <p className="eyebrow">Email verification</p>
        <h1>Verification interrupted</h1>
        <p>Atlas could not confirm this link right now. The capability remains only in this tab.</p>
      </div>
      <button className="primary-button" type="button" onClick={runVerification}>
        Try again
      </button>
    </div>
  );
}
