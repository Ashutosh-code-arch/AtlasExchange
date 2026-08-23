import { LoginForm } from "./login-form";
import { useAuthenticationSession } from "../session/use-authentication-session";

export function AuthenticationPanel(): React.JSX.Element {
  const { state, recheck } = useAuthenticationSession();

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
        {state.status === "unauthenticated" ? <LoginForm /> : null}
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
            <span>{state.user.roles.join(" · ")}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
