import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

export interface DatabaseSchema {
  atlas_system_metadata: {
    key: string;
    value: string;
    updated_at: Date;
  };
}

export interface DatabaseResources {
  readonly database: Kysely<DatabaseSchema>;
  checkReadiness(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabaseResources(
  databaseUrl: string,
  expectedSchemaVersion: string,
  onPoolError: (error: Error) => void = () => undefined,
): DatabaseResources {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", onPoolError);
  const database = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    database,
    async checkReadiness(): Promise<boolean> {
      try {
        const result = await database
          .selectFrom("atlas_system_metadata")
          .select("value")
          .where("key", "=", "schema_version")
          .executeTakeFirst();
        await sql`select 1`.execute(database);
        return result?.value === expectedSchemaVersion;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await database.destroy();
    },
  };
}
