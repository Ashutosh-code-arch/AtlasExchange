import type { AuthenticatedContext } from "./authenticated-context.js";
import type { SessionReader } from "./session-reader.js";
import { sessionIdleExpiresAt } from "./session-policy.js";

export interface ListedSession {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly current: boolean;
}

export interface ListSessionsDependencies {
  readonly sessionReader: SessionReader;
  readonly now?: () => Date;
}

export class ListSessions {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: ListSessionsDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(context: AuthenticatedContext): Promise<readonly ListedSession[]> {
    const listedAt = this.now();
    const sessions = await this.dependencies.sessionReader.listUnrevokedByUserId(context.userId);

    return sessions
      .map((session): ListedSession => ({
        ...session,
        idleExpiresAt: sessionIdleExpiresAt(session.lastActivityAt, session.absoluteExpiresAt),
        current: session.id === context.sessionId,
      }))
      .filter((session) => session.idleExpiresAt.getTime() > listedAt.getTime())
      .sort((left, right) => {
        if (left.current !== right.current) {
          return left.current ? -1 : 1;
        }
        return (
          right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
          right.createdAt.getTime() - left.createdAt.getTime() ||
          left.id.localeCompare(right.id)
        );
      });
  }
}
