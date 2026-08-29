export type AdministrationAuditInvariantIssue =
  | "ADMINISTRATION_AUDIT_ACTOR_INVALID"
  | "ADMINISTRATION_AUDIT_CREATED_AT_INVALID"
  | "ADMINISTRATION_AUDIT_DETAILS_INVALID"
  | "ADMINISTRATION_AUDIT_IDEMPOTENCY_CONFLICT"
  | "ADMINISTRATION_AUDIT_ID_INVALID"
  | "ADMINISTRATION_AUDIT_OCCURRED_AT_INVALID"
  | "ADMINISTRATION_AUDIT_OPERATION_ID_INVALID"
  | "ADMINISTRATION_AUDIT_REASON_INVALID"
  | "ADMINISTRATION_AUDIT_REQUEST_ID_INVALID"
  | "ADMINISTRATION_AUDIT_TARGET_INVALID";

export class AdministrationAuditInvariantError extends Error {
  public constructor(public readonly issue: AdministrationAuditInvariantIssue) {
    super("Administration audit invariant failed: " + issue);
    this.name = "AdministrationAuditInvariantError";
  }
}
