import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

export interface DatabaseSchema {
  atlas_system_metadata: {
    key: string;
    value: string;
    updated_at: Date;
  };
}

export interface DatabaseResources<Schema extends DatabaseSchema = DatabaseSchema> {
  readonly database: Kysely<Schema>;
  checkReadiness(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabaseResources<Schema extends DatabaseSchema = DatabaseSchema>(
  databaseUrl: string,
  expectedSchemaVersion: string,
  onPoolError: (error: Error) => void = () => undefined,
): DatabaseResources<Schema> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", onPoolError);
  const database = new Kysely<Schema>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    database,
    async checkReadiness(): Promise<boolean> {
      try {
        const result = await sql<{ value: string }>`
          SELECT value
          FROM atlas_system_metadata
          WHERE key = 'schema_version'
        `.execute(database);
        await sql`select 1`.execute(database);
        return result.rows[0]?.value === expectedSchemaVersion;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await database.destroy();
    },
  };
}
