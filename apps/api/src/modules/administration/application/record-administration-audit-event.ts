import {
  parseCreateAdministrationAuditEventInput,
  type AdministrationAuditEventRecord,
  type CreateAdministrationAuditEventInput,
} from "../domain/administration-audit-event.js";

export type RecordAdministrationAuditEventResult =
  | { readonly status: "created"; readonly event: AdministrationAuditEventRecord }
  | { readonly status: "existing"; readonly event: AdministrationAuditEventRecord };

export interface AdministrationAuditWriter {
  appendOrGet(
    input: CreateAdministrationAuditEventInput,
  ): Promise<RecordAdministrationAuditEventResult>;
}

export class RecordAdministrationAuditEvent {
  public constructor(private readonly writer: AdministrationAuditWriter) {}

  public async execute(input: unknown): Promise<RecordAdministrationAuditEventResult> {
    return this.writer.appendOrGet(parseCreateAdministrationAuditEventInput(input));
  }
}
