export interface UserSessionRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface SessionReader {
  listUnrevokedByUserId(userId: string): Promise<readonly UserSessionRecord[]>;
}
