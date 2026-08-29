export {
  AdministrationAuthorizationError,
  administrationPermissions,
  requireAdministrationAuthorization,
  type AdministrationActor,
  type AdministrationPermission,
} from "./application/administration-authorization.js";
export type {
  AdministrationRequestRateLimitDecision,
  AdministrationRequestRateLimiter,
} from "./application/administration-request-rate-limiter.js";
export type {
  AdministrationUserCommandTransactionResult,
  AdministrationUserCommandTransactionRunner,
  ChangeAdministrationAdminRoleTransactionInput,
  ChangeAdministrationUserStateTransactionInput,
} from "./application/administration-user-command-transaction.js";
export {
  ChangeAdministrationAdminRole,
  type ChangeAdministrationAdminRoleResult,
} from "./application/change-administration-admin-role.js";
export {
  ChangeAdministrationUserState,
  type ChangeAdministrationUserStateResult,
} from "./application/change-administration-user-state.js";
export {
  GetAdministrationUser,
  type GetAdministrationUserResult,
} from "./application/get-administration-user.js";
export {
  RecordAdministrationAuditEvent,
  type AdministrationAuditWriter,
  type RecordAdministrationAuditEventResult,
} from "./application/record-administration-audit-event.js";
export {
  AdministrationAuditEventRecord,
  administrationAuditActions,
  parseCreateAdministrationAuditEventInput,
  type AdministrationAuditAction,
  type CreateAdministrationAuditEventInput,
} from "./domain/administration-audit-event.js";
export {
  AdministrationAuditInvariantError,
  type AdministrationAuditInvariantIssue,
} from "./domain/administration-audit-invariant-error.js";
export type { AdministrationDatabaseSchema } from "./infrastructure/persistence/administration-database-schema.js";
export {
  createAdministrationRouter,
  type AdministrationRouterOptions,
} from "./http/administration-router.js";
export { PostgresAdministrationUserCommandTransactionRunner } from "./infrastructure/persistence/postgres-administration-user-command-transaction-runner.js";
export {
  PostgresAdministrationAuditWriter,
  bindPostgresAdministrationAuditWriter,
} from "./infrastructure/persistence/postgres-administration-audit-writer.js";
export {
  InMemoryAdministrationRequestRateLimiter,
  administrationRequestRateLimitWindowMilliseconds,
  type InMemoryAdministrationRequestRateLimiterOptions,
} from "./infrastructure/security/in-memory-administration-request-rate-limiter.js";
export {
  createAdministrationModuleRouter,
  type CreateAdministrationModuleRouterOptions,
} from "./administration-module.js";
