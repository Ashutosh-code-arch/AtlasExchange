export const identityRoles = ["user", "admin"] as const;

export type IdentityRole = (typeof identityRoles)[number];

export interface AuthenticatedContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly authorization: {
    readonly roles: readonly IdentityRole[];
  };
  readonly requestId: string;
}
