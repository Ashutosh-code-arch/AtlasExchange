import { useEffect, useRef, useState } from "react";

import { LoginForm } from "./login-form";
import { RegistrationForm } from "./registration-form";
import { useAuthenticationSession } from "../session/use-authentication-session";

export function AuthenticationPanel(): React.JSX.Element {
  const { state, recheck, signOut } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [anonymousMode, setAnonymousMode] = useState<"sign-in" | "register">("sign-in");

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
              <div className="authentication-mode-switch">
                <span>New to Atlas?</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setAnonymousMode("register")}
                >
                  Create account
                </button>
              </div>
            </div>
          ) : (
            <RegistrationForm onReturnToSignIn={() => setAnonymousMode("sign-in")} />
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
          <div className="authentication-panel__identity">
            <span>Authenticated as</span>
            <strong>{state.user.email}</strong>
            <span className="authentication-panel__roles">{state.user.roles.join(" · ")}</span>
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
        ) : null}
      </div>
    </section>
  );
}
