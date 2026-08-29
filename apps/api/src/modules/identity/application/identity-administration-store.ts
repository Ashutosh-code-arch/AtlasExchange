import type { IdentityAccountState } from "../domain/account-state.js";
import type { IdentityRole } from "./authenticated-context.js";

export interface IdentityAdministrationUser {
  readonly id: string;
  readonly email: string;
  readonly state: IdentityAccountState;
  readonly roles: readonly IdentityRole[];
  readonly createdAt: string;
}

export interface IdentityAdministrationStore {
  findUser(userId: string): Promise<IdentityAdministrationUser | undefined>;
  lockUser(userId: string): Promise<IdentityAdministrationUser | undefined>;
  setAccountState(userId: string, state: "active" | "suspended", changedAt: Date): Promise<void>;
  grantAdminRole(userId: string, assignedByUserId: string, assignedAt: Date): Promise<void>;
  revokeAdminRole(userId: string): Promise<void>;
  revokeActiveSessions(userId: string, revokedAt: Date, reason: string): Promise<void>;
}
