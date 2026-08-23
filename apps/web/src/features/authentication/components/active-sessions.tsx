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
  const { listSessions, state: sessionState } = useAuthenticationSession();
  const mountedRef = useRef(true);
  const [inventory, setInventory] = useState<SessionInventoryState>({ status: "loading" });

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
    setInventory({ status: "loading" });
    requestSessions();
  }, [requestSessions]);

  useEffect(() => {
    if (sessionState.status === "checking") {
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
              </li>
            ))}
          </ol>
          <button className="text-button" type="button" onClick={loadSessions}>
            Refresh sessions
          </button>
        </>
      ) : null}
    </section>
  );
}
