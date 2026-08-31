import { useEffect, useRef, useState } from "react";

import { LoginForm } from "./login-form";
import { ActiveSessions } from "./active-sessions";
import { PasswordRecoveryForm } from "./password-recovery-form";
import { RegistrationForm } from "./registration-form";
import { useAuthenticationSession } from "../session/use-authentication-session";

export interface AuthenticationPanelProps {
  readonly publicAccountFeatures?: Readonly<{
    registrationEnabled: boolean;
    passwordRecoveryEnabled: boolean;
  }>;
}

const defaultPublicAccountFeatures = Object.freeze({
  registrationEnabled: true,
  passwordRecoveryEnabled: true,
});

export function AuthenticationPanel({
  publicAccountFeatures = defaultPublicAccountFeatures,
}: AuthenticationPanelProps = {}): React.JSX.Element {
  const { state, recheck, signOut } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [anonymousMode, setAnonymousMode] = useState<"sign-in" | "register" | "recover">("sign-in");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSignOut = (): void => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setSignOutError(null);
    void signOut()
      .then(() => {
        if (mountedRef.current) {
          setAnonymousMode("sign-in");
          setShowSessions(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setSignOutError("Sign out is unavailable. Try again.");
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSigningOut(false);
        }
      });
  };

  return (
    <section className="authentication-panel" aria-labelledby="authentication-title">
      <div className="authentication-panel__intro">
        <p className="eyebrow">Identity boundary</p>
        <h2 id="authentication-title">Access Atlas</h2>
        <p>Server-confirmed sessions. Rotating credentials. No browser token storage.</p>
      </div>
      <div className="authentication-panel__content" aria-live="polite">
        {state.status === "checking" ? (
          <p className="authentication-panel__status">Checking your session…</p>
        ) : null}
        {state.status === "unauthenticated" ? (
          anonymousMode === "sign-in" ? (
            <div className="authentication-anonymous-flow">
              <LoginForm />
              {publicAccountFeatures.registrationEnabled ||
              publicAccountFeatures.passwordRecoveryEnabled ? (
                <div className="authentication-mode-switch">
                  {publicAccountFeatures.passwordRecoveryEnabled ? (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setAnonymousMode("recover")}
                    >
                      Forgot password?
                    </button>
                  ) : null}
                  {publicAccountFeatures.registrationEnabled ? (
                    <>
                      <span>New to Atlas?</span>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setAnonymousMode("register")}
                      >
                        Create account
                      </button>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="authentication-panel__invitation">
                  Invitation-only demo. Sign in with the account provided by the operator.
                </p>
              )}
            </div>
          ) : anonymousMode === "register" ? (
            <RegistrationForm onReturnToSignIn={() => setAnonymousMode("sign-in")} />
          ) : (
            <PasswordRecoveryForm onReturnToSignIn={() => setAnonymousMode("sign-in")} />
          )
        ) : null}
        {state.status === "unavailable" ? (
          <div className="authentication-panel__message">
            <p>Identity services cannot be reached right now.</p>
            <button className="text-button" type="button" onClick={() => void recheck()}>
              Retry session check
            </button>
          </div>
        ) : null}
        {state.status === "authenticated" ? (
          <div className="authentication-panel__authenticated">
            <div className="authentication-panel__identity">
              <span>Authenticated as</span>
              <strong>{state.user.email}</strong>
              <span className="authentication-panel__roles">{state.user.roles.join(" · ")}</span>
              <button
                className="text-button"
                type="button"
                disabled={signingOut}
                onClick={() => setShowSessions(true)}
              >
                View sessions
              </button>
              <button
                className="text-button"
                type="button"
                disabled={signingOut}
                onClick={handleSignOut}
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
              {signOutError === null ? null : (
                <p className="authentication-panel__sign-out-error" role="alert">
                  {signOutError}
                </p>
              )}
            </div>
            {showSessions ? <ActiveSessions onClose={() => setShowSessions(false)} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
