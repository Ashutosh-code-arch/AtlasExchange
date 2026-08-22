import type { AuthenticatedContext } from "./authenticated-context.js";
import type { RevokeSessionTransactionRunner } from "./revoke-session-transaction.js";
import type { SessionCsrfTokenService } from "./session-csrf-token-service.js";

export interface RevokeSessionCommand {
  readonly context: AuthenticatedContext;
  readonly targetSessionId: string;
  readonly csrfCookie: string | undefined;
  readonly csrfHeader: string | undefined;
}

export type RevokeSessionResult =
  | { readonly status: "csrf_failed" }
  | {
      readonly status: "completed";
      readonly revokedCurrentSession: boolean;
    };

export interface RevokeSessionDependencies {
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly transactionRunner: RevokeSessionTransactionRunner;
  readonly now?: () => Date;
}

export class RevokeSession {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: RevokeSessionDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: RevokeSessionCommand): Promise<RevokeSessionResult> {
    const csrfToken = command.csrfCookie;
    if (
      csrfToken === undefined ||
      command.csrfHeader === undefined ||
      csrfToken !== command.csrfHeader ||
      !this.dependencies.sessionCsrfTokenService.verify(command.context.sessionId, csrfToken)
    ) {
      return { status: "csrf_failed" };
    }

    await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.revokeOwnedSession({
        actorUserId: command.context.userId,
        actorSessionId: command.context.sessionId,
        targetSessionId: command.targetSessionId,
        revokedAt: this.now(),
        requestId: command.context.requestId,
      }),
    );

    return {
      status: "completed",
      revokedCurrentSession: command.targetSessionId === command.context.sessionId,
    };
  }
}
