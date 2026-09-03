import type { AdministrationUser } from "@atlas/contracts";
import { useRef, useState } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession, type AuthenticationHttpClient } from "../../authentication";
import {
  changeAdministrationAdminRole,
  changeAdministrationUserState,
  getAdministrationUser,
} from "../api/administration-api";

type UserLoader = typeof getAdministrationUser;
type StateChanger = typeof changeAdministrationUserState;
type RoleChanger = typeof changeAdministrationAdminRole;

export interface AdministrationWorkspaceProps {
  readonly userLoader?: UserLoader;
  readonly stateChanger?: StateChanger;
  readonly roleChanger?: RoleChanger;
  readonly operationIdFactory?: () => string;
}

interface AuthenticatedAdministrationWorkspaceProps extends Required<AdministrationWorkspaceProps> {
  readonly actorUserId: string;
  readonly request: AuthenticationHttpClient["request"];
}

type MutationKind = "role" | "state";

interface RetryOperation {
  readonly signature: string;
  readonly operationId: string;
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function safeLookupError(error: unknown): string {
  if (error instanceof ApiHttpError) {
    if (error.code === "USER_NOT_FOUND") return "No user was found for that exact ID.";
    if (error.code === "RATE_LIMITED") return "Too many lookups. Wait briefly and try again.";
    if (error.code === "ADMINISTRATION_FORBIDDEN") {
      return "Your current session no longer has Administration access.";
    }
  }
  return "The user record could not be loaded.";
}

function safeMutationError(error: unknown): string {
  if (error instanceof ApiHttpError) {
    switch (error.code) {
      case "ADMINISTRATION_SELF_TARGET_FORBIDDEN":
        return "Atlas does not allow administrators to change their own access.";
      case "IDEMPOTENCY_CONFLICT":
        return "This operation identity belongs to different intent. Change the reason and retry.";
      case "RATE_LIMITED":
        return "Too many Administration changes. Wait briefly and retry the same action.";
      case "USER_NOT_FOUND":
        return "The target user no longer exists.";
      case "USER_STATE_CONFLICT":
        return "The user changed since lookup. Reload the record before trying again.";
      case "ADMINISTRATION_FORBIDDEN":
        return "Your current session no longer has permission for this change.";
    }
  }
  return "The change was not confirmed. The displayed user remains unchanged.";
}

function isReviewedReason(reason: string): boolean {
  return (
    reason.length >= 1 &&
    reason.length <= 500 &&
    reason === reason.trim() &&
    Array.from(reason).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

function AuthenticatedAdministrationWorkspace({
  actorUserId,
  request,
  userLoader,
  stateChanger,
  roleChanger,
  operationIdFactory,
}: AuthenticatedAdministrationWorkspaceProps): React.JSX.Element {
  const lookupSequenceRef = useRef(0);
  const retryOperationRef = useRef<RetryOperation | null>(null);
  const [query, setQuery] = useState("");
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [target, setTarget] = useState<AdministrationUser | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [stateReason, setStateReason] = useState("");
  const [roleReason, setRoleReason] = useState("");
  const [pendingMutation, setPendingMutation] = useState<MutationKind | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadUser = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (lookupPending || pendingMutation !== null) return;
    const candidate = query.trim();
    if (candidate.length === 0) {
      setLookupError("Enter the exact user ID supplied by Atlas.");
      return;
    }
    const retainCurrent = target !== null && loadedQuery === candidate;
    if (!retainCurrent) {
      setTarget(null);
      setLoadedQuery(null);
      setStateReason("");
      setRoleReason("");
    }
    setLookupPending(true);
    setLookupError(null);
    setMutationError(null);
    setSuccessMessage(null);
    setStale(false);
    retryOperationRef.current = null;
    const sequence = ++lookupSequenceRef.current;
    void userLoader({ request }, candidate)
      .then((user) => {
        if (lookupSequenceRef.current !== sequence) return;
        setTarget(user);
        setLoadedQuery(candidate);
        setQuery(user.id);
      })
      .catch((error: unknown) => {
        if (lookupSequenceRef.current !== sequence) return;
        setLookupError(safeLookupError(error));
        setStale(retainCurrent);
      })
      .finally(() => {
        if (lookupSequenceRef.current === sequence) setLookupPending(false);
      });
  };

  const operationIdFor = (signature: string): string => {
    const existing = retryOperationRef.current;
    if (existing?.signature === signature) return existing.operationId;
    const operation = { signature, operationId: operationIdFactory() };
    retryOperationRef.current = operation;
    return operation.operationId;
  };

  const changeState = (): void => {
    if (target === null || pendingMutation !== null || !isReviewedReason(stateReason)) return;
    const state = target.state === "active" ? "suspended" : "active";
    const signature = JSON.stringify(["state", target.id, state, stateReason]);
    setPendingMutation("state");
    setMutationError(null);
    setSuccessMessage(null);
    void stateChanger(
      { request },
      {
        userId: target.id,
        operationId: operationIdFor(signature),
        state,
        reason: stateReason,
      },
    )
      .then((user) => {
        setTarget(user);
        setStale(false);
        setStateReason("");
        setSuccessMessage(
          state === "suspended"
            ? "User suspended and active sessions revoked."
            : "User reactivated. A new sign-in is required.",
        );
        retryOperationRef.current = null;
      })
      .catch((error: unknown) => setMutationError(safeMutationError(error)))
      .finally(() => setPendingMutation(null));
  };

  const changeRole = (): void => {
    if (target === null || pendingMutation !== null || !isReviewedReason(roleReason)) return;
    const assigned = !target.roles.includes("admin");
    const signature = JSON.stringify(["role", target.id, assigned, roleReason]);
    setPendingMutation("role");
    setMutationError(null);
    setSuccessMessage(null);
    void roleChanger(
      { request },
      {
        userId: target.id,
        operationId: operationIdFor(signature),
        assigned,
        reason: roleReason,
      },
    )
      .then((user) => {
        setTarget(user);
        setStale(false);
        setRoleReason("");
        setSuccessMessage(
          assigned
            ? "Admin access granted. Existing target sessions were revoked."
            : "Admin access revoked. Existing target sessions were revoked.",
        );
        retryOperationRef.current = null;
      })
      .catch((error: unknown) => setMutationError(safeMutationError(error)))
      .finally(() => setPendingMutation(null));
  };

  const selfTarget = target?.id === actorUserId;
  const stateChangeAvailable = target?.state === "active" || target?.state === "suspended";
  const roleChangeAvailable = target?.state === "active";

  return (
    <section
      className="administration-workspace"
      id="administration"
      aria-labelledby="administration-title"
    >
      <div className="administration-workspace__heading">
        <div>
          <p className="eyebrow">Restricted operations</p>
          <h2 id="administration-title">Administration console</h2>
        </div>
        <div className="administration-workspace__scope">
          <span>Admin only</span>
          <p>
            Inspect one exact Atlas identity. Every accepted change revokes target sessions and
            writes immutable actor-attributed evidence.
          </p>
        </div>
      </div>

      <dl className="administration-safeguards" aria-label="Administration safeguards">
        <div>
          <dt>Exact target</dt>
          <dd>No user discovery</dd>
        </div>
        <div>
          <dt>Audit evidence</dt>
          <dd>Actor-attributed</dd>
        </div>
        <div>
          <dt>Access changes</dt>
          <dd>Session revocation</dd>
        </div>
      </dl>

      <section
        className="administration-lookup-panel"
        aria-labelledby="administration-lookup-title"
      >
        <div className="administration-lookup-panel__heading">
          <div>
            <p className="eyebrow">Exact identity lookup</p>
            <h3 id="administration-lookup-title">Select target</h3>
          </div>
          <p>Paste the immutable user identifier supplied by Atlas.</p>
        </div>
        <form className="administration-lookup" onSubmit={loadUser} aria-label="Find Atlas user">
          <label htmlFor="administration-user-id">Exact user ID</label>
          <input
            id="administration-user-id"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="00000000-0000-4000-8000-000000000000"
            autoComplete="off"
            spellCheck={false}
            disabled={lookupPending || pendingMutation !== null}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={lookupPending || pendingMutation !== null}
          >
            {lookupPending
              ? "Loading user…"
              : target !== null && loadedQuery === query.trim()
                ? "Reload user"
                : "Find user"}
          </button>
        </form>
      </section>

      {lookupError !== null ? (
        <p className="administration-workspace__notice" role="alert" data-stale={stale}>
          {lookupError} {stale ? "The last confirmed record remains visible as stale." : null}
        </p>
      ) : null}

      {target === null ? (
        <div className="administration-workspace__empty">
          <strong>No identity selected</strong>
          <p>User discovery is intentionally unavailable. Paste an exact Atlas user ID to begin.</p>
        </div>
      ) : (
        <div className="administration-console" data-stale={stale}>
          <article
            className="administration-user-card"
            aria-label={`Administration record for ${target.email}`}
          >
            <div className="administration-user-card__identity">
              <p className="eyebrow">Target identity</p>
              <span data-state={target.state}>{target.state.replace("_", " ")}</span>
              <h3>{target.email}</h3>
              <code>{target.id}</code>
            </div>
            <dl>
              <div>
                <dt>Roles</dt>
                <dd>{target.roles.join(" · ")}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{displayTimestamp(target.createdAt)}</dd>
              </div>
              <div>
                <dt>Record</dt>
                <dd>{stale ? "Stale · reload required" : "Server confirmed"}</dd>
              </div>
            </dl>
          </article>

          {selfTarget ? (
            <div className="administration-self-protection" role="status">
              <strong>Self-management blocked</strong>
              <p>Use a different authorized operator for changes to your own Atlas access.</p>
            </div>
          ) : (
            <div className="administration-controls">
              <section aria-labelledby="administration-state-control">
                <div>
                  <p className="eyebrow">Account state</p>
                  <h3 id="administration-state-control">
                    {stateChangeAvailable
                      ? target.state === "active"
                        ? "Suspend this user"
                        : "Reactivate this user"
                      : "State is operator-locked"}
                  </h3>
                  <p>
                    {stateChangeAvailable
                      ? "The target must sign in again after this change."
                      : "Pending and disabled identities cannot be changed from this console."}
                  </p>
                </div>
                <label htmlFor="administration-state-reason">Reviewed reason</label>
                <input
                  id="administration-state-reason"
                  value={stateReason}
                  onChange={(event) => setStateReason(event.target.value)}
                  maxLength={500}
                  disabled={!stateChangeAvailable || pendingMutation !== null || stale}
                />
                <button
                  className="administration-action administration-action--danger"
                  type="button"
                  onClick={changeState}
                  disabled={
                    !stateChangeAvailable ||
                    !isReviewedReason(stateReason) ||
                    pendingMutation !== null ||
                    stale
                  }
                >
                  {pendingMutation === "state"
                    ? "Confirming state…"
                    : target.state === "active"
                      ? "Confirm suspension"
                      : "Confirm reactivation"}
                </button>
              </section>

              <section aria-labelledby="administration-role-control">
                <div>
                  <p className="eyebrow">Admin role</p>
                  <h3 id="administration-role-control">
                    {target.roles.includes("admin") ? "Revoke admin access" : "Grant admin access"}
                  </h3>
                  <p>
                    {roleChangeAvailable
                      ? "Role changes revoke every active target session before commit."
                      : "The target must be active before its admin role can change."}
                  </p>
                </div>
                <label htmlFor="administration-role-reason">Reviewed reason</label>
                <input
                  id="administration-role-reason"
                  value={roleReason}
                  onChange={(event) => setRoleReason(event.target.value)}
                  maxLength={500}
                  disabled={!roleChangeAvailable || pendingMutation !== null || stale}
                />
                <button
                  className="administration-action"
                  type="button"
                  onClick={changeRole}
                  disabled={
                    !roleChangeAvailable ||
                    !isReviewedReason(roleReason) ||
                    pendingMutation !== null ||
                    stale
                  }
                >
                  {pendingMutation === "role"
                    ? "Confirming role…"
                    : target.roles.includes("admin")
                      ? "Confirm admin revocation"
                      : "Confirm admin grant"}
                </button>
              </section>
            </div>
          )}

          {mutationError !== null ? (
            <p className="administration-workspace__mutation-message" role="alert">
              {mutationError}
            </p>
          ) : null}
          {successMessage !== null ? (
            <p
              className="administration-workspace__mutation-message"
              role="status"
              data-success="true"
            >
              {successMessage}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function AdministrationWorkspace({
  userLoader = getAdministrationUser,
  stateChanger = changeAdministrationUserState,
  roleChanger = changeAdministrationAdminRole,
  operationIdFactory = () => crypto.randomUUID(),
}: AdministrationWorkspaceProps): React.JSX.Element | null {
  const { state, request } = useAuthenticationSession();
  if (state.status !== "authenticated" || !state.user.roles.includes("admin")) return null;
  return (
    <AuthenticatedAdministrationWorkspace
      key={state.user.id}
      actorUserId={state.user.id}
      request={request}
      userLoader={userLoader}
      stateChanger={stateChanger}
      roleChanger={roleChanger}
      operationIdFactory={operationIdFactory}
    />
  );
}
