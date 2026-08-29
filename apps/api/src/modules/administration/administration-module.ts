import type { Router } from "express";
import type { Kysely } from "kysely";

import {
  PostgresIdentityAdministrationStore,
  type AuthenticateAccess,
  type IdentityDatabaseSchema,
  type SessionCsrfTokenService,
} from "../identity/index.js";
import { ChangeAdministrationAdminRole } from "./application/change-administration-admin-role.js";
import { ChangeAdministrationUserState } from "./application/change-administration-user-state.js";
import { GetAdministrationUser } from "./application/get-administration-user.js";
import type { AdministrationRequestRateLimiter } from "./application/administration-request-rate-limiter.js";
import { createAdministrationRouter } from "./http/administration-router.js";
import type { AdministrationDatabaseSchema } from "./infrastructure/persistence/administration-database-schema.js";
import { PostgresAdministrationUserCommandTransactionRunner } from "./infrastructure/persistence/postgres-administration-user-command-transaction-runner.js";
import { InMemoryAdministrationRequestRateLimiter } from "./infrastructure/security/in-memory-administration-request-rate-limiter.js";

type AdministrationModuleDatabaseSchema = AdministrationDatabaseSchema & IdentityDatabaseSchema;

export interface CreateAdministrationModuleRouterOptions {
  readonly database: Kysely<AdministrationModuleDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly readRateLimiter?: AdministrationRequestRateLimiter;
  readonly mutationRateLimiter?: AdministrationRequestRateLimiter;
  readonly now?: () => Date;
}

export function createAdministrationModuleRouter(
  options: CreateAdministrationModuleRouterOptions,
): Router {
  const transactions = new PostgresAdministrationUserCommandTransactionRunner(options.database);
  const clockOptions = options.now === undefined ? {} : { now: options.now };
  return createAdministrationRouter({
    authenticateAccess: options.authenticateAccess,
    sessionCsrfTokenService: options.sessionCsrfTokenService,
    secureCookies: options.secureCookies,
    webOrigin: options.webOrigin,
    getUser: new GetAdministrationUser(new PostgresIdentityAdministrationStore(options.database)),
    changeUserState: new ChangeAdministrationUserState(transactions, clockOptions),
    changeAdminRole: new ChangeAdministrationAdminRole(transactions, clockOptions),
    readRateLimiter:
      options.readRateLimiter ??
      new InMemoryAdministrationRequestRateLimiter({ maximumRequests: 60 }),
    mutationRateLimiter:
      options.mutationRateLimiter ??
      new InMemoryAdministrationRequestRateLimiter({ maximumRequests: 20 }),
  });
}
