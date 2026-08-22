import { parseAccessCredential } from "../domain/access-credential.js";
import type { AccessSessionAuthenticator } from "./access-session-authenticator.js";
import type { AuthenticatedContext } from "./authenticated-context.js";

export interface AuthenticateAccessCommand {
  readonly accessCredential: string;
  readonly requestId: string;
}

export type AuthenticateAccessResult =
  | { readonly status: "authentication_required" }
  | {
      readonly status: "authenticated";
      readonly context: AuthenticatedContext;
      readonly user: {
        readonly email: string;
      };
    };

export interface AuthenticateAccessDependencies {
  readonly accessSessionAuthenticator: AccessSessionAuthenticator;
  readonly now?: () => Date;
}

export class AuthenticateAccess {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: AuthenticateAccessDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: AuthenticateAccessCommand): Promise<AuthenticateAccessResult> {
    const credential = parseAccessCredential(command.accessCredential);
    if (credential === undefined) {
      return { status: "authentication_required" };
    }

    const session = await this.dependencies.accessSessionAuthenticator.authenticate({
      ...credential,
      authenticatedAt: this.now(),
    });
    if (session === undefined) {
      return { status: "authentication_required" };
    }

    return {
      status: "authenticated",
      context: {
        userId: session.userId,
        sessionId: session.sessionId,
        authorization: { roles: session.roles },
        requestId: command.requestId,
      },
      user: { email: session.displayEmail },
    };
  }
}
