import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../../migrations/", import.meta.url),
);

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS atlas_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function applyMigrations(
  databaseUrl: string,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [7_283_651]);
    await ensureMigrationTable(client);

    const result = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM atlas_schema_migrations ORDER BY name",
    );
    const applied = new Map(result.rows.map((migration) => [migration.name, migration.checksum]));
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const name of files) {
      const migrationSql = await readFile(join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(migrationSql).digest("hex");
      const existingChecksum = applied.get(name);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) {
          throw new Error(`Previously applied migration has changed: ${name}`);
        }
        continue;
      }

      await client.query(migrationSql);
      await client.query("INSERT INTO atlas_schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
      appliedNow.push(name);
    }

    await client.query("COMMIT");
    return appliedNow;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
