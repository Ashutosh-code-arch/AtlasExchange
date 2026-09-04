import { useEffect, useRef, useState } from "react";

import { LoginForm } from "./login-form";
import { ActiveSessions } from "./active-sessions";
import { OperatorEmailTest } from "./operator-email-test";
import { PasswordRecoveryForm } from "./password-recovery-form";
import { RegistrationForm } from "./registration-form";
import { useAuthenticationSession } from "../session/use-authentication-session";

export interface AuthenticationPanelProps {
  readonly publicAccountFeatures?: Readonly<{
    registrationEnabled: boolean;
    passwordRecoveryEnabled: boolean;
  }>;
  readonly humanVerification?:
    | Readonly<{ enabled: false }>
    | Readonly<{ enabled: true; provider: "turnstile"; siteKey: string }>;
}

const defaultPublicAccountFeatures = Object.freeze({
  registrationEnabled: true,
  passwordRecoveryEnabled: true,
});

export function AuthenticationPanel({
  publicAccountFeatures = defaultPublicAccountFeatures,
  humanVerification = { enabled: false },
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

  const authenticated = state.status === "authenticated";

  return (
    <section
      className={`authentication-panel${authenticated ? " authentication-panel--authenticated" : ""}`}
      aria-labelledby="authentication-title"
    >
      <div className="authentication-panel__intro">
        <p className="eyebrow">{authenticated ? "Account and security" : "Identity boundary"}</p>
        <h2 id="authentication-title">{authenticated ? "Profile & security" : "Access Atlas"}</h2>
        <p>
          {authenticated
            ? "Review your server-confirmed identity and control active Atlas sessions."
            : "Server-confirmed sessions. Rotating credentials. No browser token storage."}
        </p>
      </div>
      <div className="authentication-panel__content" aria-live="polite">
        {state.status === "checking" ? (
          <p className="authentication-panel__status">Checking your session…</p>
        ) : null}
        {state.status === "unauthenticated" ? (
          anonymousMode === "sign-in" ? (
            <div className="authentication-anonymous-flow">
              <LoginForm humanVerification={humanVerification} />
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
            <RegistrationForm
              humanVerification={humanVerification}
              onReturnToSignIn={() => setAnonymousMode("sign-in")}
            />
          ) : (
            <PasswordRecoveryForm
              humanVerification={humanVerification}
              onReturnToSignIn={() => setAnonymousMode("sign-in")}
            />
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
            <div className="profile-security-grid">
              <article className="profile-identity-card" aria-labelledby="profile-identity-title">
                <div className="profile-identity-card__primary">
                  <span className="profile-identity-card__avatar" aria-hidden="true">
                    {state.user.email.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <p className="eyebrow">Signed-in identity</p>
                    <h3 id="profile-identity-title">{state.user.email}</h3>
                    <span className="profile-status-chip">Server confirmed</span>
                  </div>
                </div>
                <dl className="profile-identity-card__details">
                  <div>
                    <dt>User ID</dt>
                    <dd>
                      <code>{state.user.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Roles</dt>
                    <dd>{state.user.roles.join(" · ")}</dd>
                  </div>
                  <div>
                    <dt>Credential model</dt>
                    <dd>Server session</dd>
                  </div>
                </dl>
              </article>

              <section className="profile-session-security" aria-labelledby="profile-session-title">
                <div className="profile-session-security__heading">
                  <div>
                    <p className="eyebrow">Security controls</p>
                    <h3 id="profile-session-title">Session security</h3>
                  </div>
                  <span className="profile-status-chip">Protected</span>
                </div>
                <p className="profile-session-security__description">
                  Atlas keeps credentials out of browser storage and validates access with the
                  server on every protected request.
                </p>
                <dl className="profile-session-security__facts">
                  <div>
                    <dt>Browser storage</dt>
                    <dd>No access token</dd>
                  </div>
                  <div>
                    <dt>Session state</dt>
                    <dd>Server confirmed</dd>
                  </div>
                  <div>
                    <dt>Credential rotation</dt>
                    <dd>Automatic</dd>
                  </div>
                </dl>
                <div className="profile-session-security__actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={signingOut}
                    onClick={() => setShowSessions(true)}
                  >
                    View sessions
                  </button>
                  <button
                    className="text-button text-button--danger"
                    type="button"
                    disabled={signingOut}
                    onClick={handleSignOut}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
                {signOutError === null ? null : (
                  <p className="authentication-panel__sign-out-error" role="alert">
                    {signOutError}
                  </p>
                )}
              </section>
            </div>
            {showSessions ? <ActiveSessions onClose={() => setShowSessions(false)} /> : null}
            <OperatorEmailTest key={state.user.id} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
