import { parseRefreshCredential } from "../domain/refresh-credential.js";
import type { LogoutAllSessionsTransactionRunner } from "./logout-all-sessions-transaction.js";
import type { SessionCsrfTokenService } from "./session-csrf-token-service.js";

export interface LogoutAllSessionsCommand {
  readonly refreshCredential: string;
  readonly csrfCookie: string | undefined;
  readonly csrfHeader: string | undefined;
  readonly requestId: string;
}

export type LogoutAllSessionsResult =
  | { readonly status: "authentication_required" }
  | { readonly status: "csrf_failed" }
  | { readonly status: "logged_out" };

export interface LogoutAllSessionsDependencies {
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly transactionRunner: LogoutAllSessionsTransactionRunner;
  readonly now?: () => Date;
}

export class LogoutAllSessions {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: LogoutAllSessionsDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: LogoutAllSessionsCommand): Promise<LogoutAllSessionsResult> {
    const csrfToken = command.csrfCookie;
    if (
      csrfToken === undefined ||
      command.csrfHeader === undefined ||
      csrfToken !== command.csrfHeader
    ) {
      return { status: "csrf_failed" };
    }
    const credential = parseRefreshCredential(command.refreshCredential);
    if (credential === undefined) {
      return { status: "authentication_required" };
    }

    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.revokeAllSessions({
        ...credential,
        revokedAt: this.now(),
        requestId: command.requestId,
        authorizeSession: (sessionId) =>
          this.dependencies.sessionCsrfTokenService.verify(sessionId, csrfToken),
      }),
    );
    if (result.status === "csrf_failed") {
      return result;
    }
    return result.status === "revoked"
      ? { status: "logged_out" }
      : { status: "authentication_required" };
  }
}
