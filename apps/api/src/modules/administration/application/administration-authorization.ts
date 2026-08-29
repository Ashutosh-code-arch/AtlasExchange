import type { AuthenticatedContext } from "../../identity/index.js";

export const administrationPermissions = [
  "administration.users.read",
  "administration.users.change_state",
  "administration.roles.manage",
  "administration.audit.read",
] as const;

export type AdministrationPermission = (typeof administrationPermissions)[number];

export interface AdministrationActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
}

export class AdministrationAuthorizationError extends Error {
  public constructor(public readonly permission: string) {
    super("Administration authorization is required.");
    this.name = "AdministrationAuthorizationError";
  }
}

const administrationPermissionSet = new Set<string>(administrationPermissions);

export function requireAdministrationAuthorization(
  context: AuthenticatedContext,
  permission: AdministrationPermission,
): AdministrationActor {
  if (
    !administrationPermissionSet.has(permission) ||
    !context.authorization.roles.includes("admin")
  ) {
    throw new AdministrationAuthorizationError(permission);
  }
  return {
    userId: context.userId,
    sessionId: context.sessionId,
    requestId: context.requestId,
  };
}
