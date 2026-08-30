import { Pool, type PoolClient } from "pg";

import {
  defaultMigrationsDirectory,
  readMigrationManifest,
  type MigrationManifestEntry,
} from "./migration-runner.js";

export const recoveryValidationCheckNames = [
  "schema_version",
  "migration_history",
  "wallet_account_pairs",
  "journal_posting_structure",
  "journal_asset_balance",
  "user_account_non_negative",
] as const;

export type RecoveryValidationCheckName = (typeof recoveryValidationCheckNames)[number];

export interface RecoveryValidationCheck {
  readonly name: RecoveryValidationCheckName;
  readonly passed: boolean;
  readonly violations: number;
}

export interface RecoveryValidationRowCounts {
  readonly users: number;
  readonly wallets: number;
  readonly journals: number;
  readonly orders: number;
  readonly trades: number;
}

export interface RecoveryValidationReport {
  readonly passed: boolean;
  readonly schemaVersion: {
    readonly expected: string;
    readonly restored: string | null;
  };
  readonly migrations: {
    readonly expected: number;
    readonly restored: number;
  };
  readonly checks: readonly RecoveryValidationCheck[];
  readonly rowCounts: RecoveryValidationRowCounts;
}

interface CountRow {
  readonly count: string;
}

interface SchemaVersionRow {
  readonly value: string;
}

function expectedSchemaVersion(manifest: readonly MigrationManifestEntry[]): string {
  const finalMigration = manifest.at(-1);
  const match = finalMigration?.name.match(/^(\d{4})_/);

  if (match?.[1] === undefined) {
    throw new Error("Committed migration history does not declare a schema version");
  }

  return String(Number(match[1]));
}

async function violationCount(client: PoolClient, query: string): Promise<number> {
  const result = await client.query<CountRow>(query);
  const value = Number(result.rows[0]?.count);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Recovery validation query returned an invalid count");
  }

  return value;
}

async function collectRowCounts(client: PoolClient): Promise<RecoveryValidationRowCounts> {
  const result = await client.query<{
    journals: string;
    orders: string;
    trades: string;
    users: string;
    wallets: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM identity.users)::text AS users,
      (SELECT COUNT(*) FROM financial.wallets)::text AS wallets,
      (SELECT COUNT(*) FROM financial.journal_transactions)::text AS journals,
      (SELECT COUNT(*) FROM trading.orders)::text AS orders,
      (SELECT COUNT(*) FROM trading.trades)::text AS trades
  `);
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error("Recovery validation could not collect restored row counts");
  }

  const counts = {
    users: Number(row.users),
    wallets: Number(row.wallets),
    journals: Number(row.journals),
    orders: Number(row.orders),
    trades: Number(row.trades),
  };

  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Recovery validation returned invalid restored row counts");
  }

  return counts;
}

export async function validateRestoredDatabase(
  databaseUrl: string,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<RecoveryValidationReport> {
  const manifest = await readMigrationManifest(migrationsDirectory);
  const expectedVersion = expectedSchemaVersion(manifest);
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "atlas-recovery-validation",
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });

  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const schemaVersionResult = await client.query<SchemaVersionRow>(`
      SELECT value
      FROM public.atlas_system_metadata
      WHERE key = 'schema_version'
    `);
    const restoredSchemaVersion = schemaVersionResult.rows[0]?.value ?? null;
    const appliedMigrations = await client.query<MigrationManifestEntry>(`
      SELECT name, checksum
      FROM public.atlas_schema_migrations
      ORDER BY name
    `);
    const migrationHistoryMatches =
      appliedMigrations.rows.length === manifest.length &&
      appliedMigrations.rows.every((migration, index) => {
        const expectedMigration = manifest[index];
        return (
          expectedMigration !== undefined &&
          migration.name === expectedMigration.name &&
          migration.checksum === expectedMigration.checksum
        );
      });

    const checks: RecoveryValidationCheck[] = [
      {
        name: "schema_version",
        passed: restoredSchemaVersion === expectedVersion,
        violations: restoredSchemaVersion === expectedVersion ? 0 : 1,
      },
      {
        name: "migration_history",
        passed: migrationHistoryMatches,
        violations: migrationHistoryMatches ? 0 : 1,
      },
    ];

    const invariantQueries: readonly [RecoveryValidationCheckName, string][] = [
      [
        "wallet_account_pairs",
        `
          SELECT COUNT(*)::text AS count
          FROM (
            SELECT wallet.id
            FROM financial.wallets AS wallet
            LEFT JOIN financial.ledger_accounts AS account ON account.wallet_id = wallet.id
            GROUP BY wallet.id
            HAVING COUNT(*) FILTER (WHERE account.kind = 'user_available') <> 1
              OR COUNT(*) FILTER (WHERE account.kind = 'user_reserved') <> 1
              OR COUNT(*) FILTER (
                WHERE account.kind NOT IN ('user_available', 'user_reserved')
              ) <> 0
          ) AS violations
        `,
      ],
      [
        "journal_posting_structure",
        `
          SELECT COUNT(*)::text AS count
          FROM (
            SELECT journal.id
            FROM financial.journal_transactions AS journal
            LEFT JOIN financial.journal_postings AS posting ON posting.journal_id = journal.id
            GROUP BY journal.id
            HAVING COUNT(posting.position) < 2
              OR MIN(posting.position) <> 1
              OR MAX(posting.position) <> COUNT(posting.position)
          ) AS violations
        `,
      ],
      [
        "journal_asset_balance",
        `
          SELECT COUNT(*)::text AS count
          FROM (
            SELECT posting.journal_id, posting.asset_code
            FROM financial.journal_postings AS posting
            GROUP BY posting.journal_id, posting.asset_code
            HAVING SUM(
              CASE posting.direction WHEN 'debit' THEN posting.amount ELSE -posting.amount END
            ) <> 0
          ) AS violations
        `,
      ],
      [
        "user_account_non_negative",
        `
          SELECT COUNT(*)::text AS count
          FROM (
            SELECT account.id
            FROM financial.ledger_accounts AS account
            LEFT JOIN financial.journal_postings AS posting ON posting.account_id = account.id
            WHERE account.kind IN ('user_available', 'user_reserved')
            GROUP BY account.id
            HAVING COALESCE(SUM(
              CASE posting.direction WHEN 'credit' THEN posting.amount ELSE -posting.amount END
            ), 0) < 0
          ) AS violations
        `,
      ],
    ];

    for (const [name, query] of invariantQueries) {
      const violations = await violationCount(client, query);
      checks.push({ name, passed: violations === 0, violations });
    }

    const rowCounts = await collectRowCounts(client);
    await client.query("COMMIT");

    return {
      passed: checks.every((check) => check.passed),
      schemaVersion: { expected: expectedVersion, restored: restoredSchemaVersion },
      migrations: { expected: manifest.length, restored: appliedMigrations.rows.length },
      checks,
      rowCounts,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
