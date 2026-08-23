import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@atlas/contracts";

import { useAuthenticationSession } from "../session/use-authentication-session";

export interface ActiveSessionsProps {
  readonly onClose: () => void;
}

type SessionInventoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly sessions: readonly SessionSummary[] }
  | { readonly status: "unavailable" };

function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function ActiveSessions({ onClose }: ActiveSessionsProps): React.JSX.Element {
  const {
    listSessions,
    revokeSession,
    signOutEverywhere,
    state: sessionState,
  } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [inventory, setInventory] = useState<SessionInventoryState>({ status: "loading" });
  const [confirmingSessionId, setConfirmingSessionId] = useState<string | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [revocationError, setRevocationError] = useState<string | null>(null);
  const [confirmingLogoutAll, setConfirmingLogoutAll] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestSessions = useCallback((): void => {
    void listSessions()
      .then((sessions) => {
        if (mountedRef.current) {
          setInventory({ status: "ready", sessions });
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setInventory({ status: "unavailable" });
        }
      });
  }, [listSessions]);

  const loadSessions = useCallback((): void => {
    setConfirmingSessionId(null);
    setRevocationError(null);
    setConfirmingLogoutAll(false);
    setLogoutAllError(null);
    setInventory({ status: "loading" });
    requestSessions();
  }, [requestSessions]);

  const handleRevocation = (session: SessionSummary): void => {
    if (revokingSessionId !== null || signingOutEverywhere) {
      return;
    }
    setRevokingSessionId(session.id);
    setRevocationError(null);
    void revokeSession({ id: session.id, current: session.current })
      .then(() => {
        if (mountedRef.current) {
          setInventory((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  sessions: current.sessions.filter((candidate) => candidate.id !== session.id),
                }
              : current,
          );
          setConfirmingSessionId(null);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setRevocationError("This session could not be revoked. Refresh and try again.");
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRevokingSessionId(null);
        }
      });
  };

  const handleLogoutAll = (): void => {
    if (signingOutEverywhere || revokingSessionId !== null) {
      return;
    }
    setSigningOutEverywhere(true);
    setLogoutAllError(null);
    void signOutEverywhere()
      .catch(() => {
        if (mountedRef.current) {
          setLogoutAllError("Atlas could not sign out every session. Refresh and try again.");
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setSigningOutEverywhere(false);
        }
      });
  };

  useEffect(() => {
    if (sessionState.status !== "authenticated") {
      return;
    }
    requestSessions();
  }, [requestSessions, sessionState.status]);

  return (
    <section className="active-sessions" aria-labelledby="active-sessions-title">
      <div className="active-sessions__heading">
        <div>
          <p className="eyebrow">Session security</p>
          <h3 id="active-sessions-title">Active sessions</h3>
        </div>
        <button className="text-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {inventory.status === "loading" ? (
        <p className="active-sessions__status" role="status">
          Loading active sessions…
        </p>
      ) : null}
      {inventory.status === "unavailable" ? (
        <div className="active-sessions__status" role="alert">
          <p>Active sessions cannot be loaded right now.</p>
          <button className="text-button" type="button" onClick={loadSessions}>
            Try again
          </button>
        </div>
      ) : null}
      {inventory.status === "ready" && inventory.sessions.length === 0 ? (
        <p className="active-sessions__status" role="status">
          No active sessions were returned.
        </p>
      ) : null}
      {inventory.status === "ready" && inventory.sessions.length > 0 ? (
        <>
          <ol className="active-session-list">
            {inventory.sessions.map((session) => (
              <li key={session.id}>
                <div className="active-session-list__identity">
                  <strong>{session.current ? "This session" : "Other active session"}</strong>
                  {session.current ? <span>Current</span> : null}
                </div>
                <dl>
                  <div>
                    <dt>Created</dt>
                    <dd>
                      <time dateTime={session.createdAt}>
                        {formatUtcTimestamp(session.createdAt)} UTC
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Last active</dt>
                    <dd>
                      <time dateTime={session.lastActivityAt}>
                        {formatUtcTimestamp(session.lastActivityAt)} UTC
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Idle expiry</dt>
                    <dd>
                      <time dateTime={session.idleExpiresAt}>
                        {formatUtcTimestamp(session.idleExpiresAt)} UTC
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Absolute expiry</dt>
                    <dd>
                      <time dateTime={session.absoluteExpiresAt}>
                        {formatUtcTimestamp(session.absoluteExpiresAt)} UTC
                      </time>
                    </dd>
                  </div>
                </dl>
                <div className="active-session-list__actions">
                  {confirmingSessionId === session.id ? (
                    <>
                      <p>
                        {session.current
                          ? "Revoking this session will sign you out of Atlas."
                          : "Revoke this session and all credentials in its token family?"}
                      </p>
                      <button
                        className="text-button text-button--danger"
                        type="button"
                        disabled={revokingSessionId !== null || signingOutEverywhere}
                        onClick={() => handleRevocation(session)}
                      >
                        {revokingSessionId === session.id
                          ? "Revoking session…"
                          : session.current
                            ? "Confirm revoke current session"
                            : "Confirm revoke other session"}
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        disabled={revokingSessionId !== null || signingOutEverywhere}
                        onClick={() => {
                          setConfirmingSessionId(null);
                          setRevocationError(null);
                        }}
                      >
                        Cancel revocation
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-button text-button--danger"
                      type="button"
                      disabled={revokingSessionId !== null || signingOutEverywhere}
                      onClick={() => {
                        setConfirmingSessionId(session.id);
                        setRevocationError(null);
                      }}
                    >
                      {session.current ? "Revoke current session" : "Revoke other session"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {revocationError === null ? null : (
            <p className="active-sessions__revocation-error" role="alert">
              {revocationError}
            </p>
          )}
          <button className="text-button" type="button" onClick={loadSessions}>
            Refresh sessions
          </button>
        </>
      ) : null}
      {inventory.status === "ready" ? (
        <div className="active-sessions__logout-all">
          {confirmingLogoutAll ? (
            <>
              <p>Revoke every Atlas session and require a new sign-in on every device?</p>
              <button
                className="text-button text-button--danger"
                type="button"
                disabled={signingOutEverywhere || revokingSessionId !== null}
                onClick={handleLogoutAll}
              >
                {signingOutEverywhere ? "Signing out everywhere…" : "Confirm sign out everywhere"}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={signingOutEverywhere}
                onClick={() => {
                  setConfirmingLogoutAll(false);
                  setLogoutAllError(null);
                }}
              >
                Cancel sign out everywhere
              </button>
            </>
          ) : (
            <button
              className="text-button text-button--danger"
              type="button"
              disabled={revokingSessionId !== null}
              onClick={() => {
                setConfirmingLogoutAll(true);
                setLogoutAllError(null);
              }}
            >
              Sign out everywhere
            </button>
          )}
          {logoutAllError === null ? null : (
            <p className="active-sessions__revocation-error" role="alert">
              {logoutAllError}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
