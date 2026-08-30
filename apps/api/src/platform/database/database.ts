import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

export interface DatabaseSchema {
  atlas_system_metadata: {
    key: string;
    value: string;
    updated_at: Date;
  };
}

export interface DatabasePoolConfiguration {
  readonly maximumConnections: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maximumLifetimeSeconds: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly readinessTimeoutMs: number;
}

export interface DatabasePoolSnapshot {
  readonly maximumConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingRequests: number;
}

export interface DatabaseResourceOptions {
  readonly pool?: DatabasePoolConfiguration;
  readonly onPoolConnect?: () => void;
  readonly onPoolRemove?: () => void;
  readonly onPoolError?: (error: Error) => void;
}

export interface DatabaseResources<Schema extends DatabaseSchema = DatabaseSchema> {
  readonly database: Kysely<Schema>;
  checkReadiness(): Promise<boolean>;
  poolSnapshot(): DatabasePoolSnapshot;
  close(): Promise<void>;
}

const defaultPoolConfiguration: DatabasePoolConfiguration = Object.freeze({
  maximumConnections: 10,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 30_000,
  maximumLifetimeSeconds: 300,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleTransactionTimeoutMs: 30_000,
  readinessTimeoutMs: 1_000,
});

export function createDatabaseResources<Schema extends DatabaseSchema = DatabaseSchema>(
  databaseUrl: string,
  expectedSchemaVersion: string,
  options: DatabaseResourceOptions = {},
): DatabaseResources<Schema> {
  const configuration = options.pool ?? defaultPoolConfiguration;
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "atlas-api",
    max: configuration.maximumConnections,
    connectionTimeoutMillis: configuration.connectionTimeoutMs,
    idleTimeoutMillis: configuration.idleTimeoutMs,
    maxLifetimeSeconds: configuration.maximumLifetimeSeconds,
    statement_timeout: configuration.statementTimeoutMs,
    lock_timeout: configuration.lockTimeoutMs,
    idle_in_transaction_session_timeout: configuration.idleTransactionTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  let pendingCloseRemovals = 0;
  let resolveCloseRemovals: (() => void) | undefined;
  if (options.onPoolConnect !== undefined) pool.on("connect", options.onPoolConnect);
  pool.on("remove", () => {
    if (pendingCloseRemovals > 0) {
      pendingCloseRemovals -= 1;
      if (pendingCloseRemovals === 0) resolveCloseRemovals?.();
    }
    options.onPoolRemove?.();
  });
  pool.on("error", options.onPoolError ?? (() => undefined));

  const database = new Kysely<Schema>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    database,
    async checkReadiness(): Promise<boolean> {
      try {
        return await database
          .transaction()
          .setAccessMode("read only")
          .execute(async (transaction) => {
            await sql`SELECT set_config(
              'statement_timeout',
              ${`${configuration.readinessTimeoutMs}ms`},
              true
            )`.execute(transaction);
            const result = await sql<{ value: string }>`
              SELECT value
              FROM atlas_system_metadata
              WHERE key = 'schema_version'
            `.execute(transaction);
            return result.rows[0]?.value === expectedSchemaVersion;
          });
      } catch {
        return false;
      }
    },
    poolSnapshot(): DatabasePoolSnapshot {
      return {
        maximumConnections: configuration.maximumConnections,
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        activeConnections: Math.max(0, pool.totalCount - pool.idleCount),
        waitingRequests: pool.waitingCount,
      };
    },
    async close(): Promise<void> {
      pendingCloseRemovals = pool.totalCount;
      const connectionsClosed =
        pendingCloseRemovals === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              resolveCloseRemovals = resolve;
            });
      await database.destroy();
      await connectionsClosed;
    },
  };
}
