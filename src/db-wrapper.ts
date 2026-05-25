import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import {
  sql,
  type PreparedStatement,
  type Primitive,
  type SqlQueryFragment,
  type SqlRow,
} from "./sql-tag.js";

type FragmentOrStatement = PreparedStatement | SqlQueryFragment;

interface BaseDatabaseWrapper {
  storage: SqlStorage;

  /** @link https://developers.cloudflare.com/d1/sql-api/sql-statements/#compatible-pragma-statements */
  pragma: (pragma: string) => Primitive;
  /** @link https://developers.cloudflare.com/d1/sql-api/sql-statements/#compatible-pragma-statements */
  pragmaFull: <TRow extends SqlRow>(pragma: string) => TRow[];
  run(statement: FragmentOrStatement): { rowsRead: number; rowsWritten: number };
  queryNone(statement: FragmentOrStatement): void;
  queryNoneOrOne<TRow extends SqlRow>(statement: FragmentOrStatement): TRow | null;
  queryOne<TRow extends SqlRow>(statement: FragmentOrStatement): TRow;
  queryMany<TRow extends SqlRow>(statement: FragmentOrStatement): TRow[];
}

export interface RootDatabaseWrapper extends BaseDatabaseWrapper {
  withCallbacks(callbacks: QueryCallbacks): RootDatabaseWrapper;
  transactionSync<T>(fn: () => T): T;
  /**
   * Apply pending migrations. Async because migrations that set `disableForeignKeys` need to commit
   * the implicit transaction (via `storage.sync()`) in order to toggle foreign key enforcement,
   * which SQLite only allows when no transaction is open. Run it where you can await — typically
   * `ctx.blockConcurrencyWhile(() => db.migrate(migrations))` in the Durable Object constructor.
   */
  migrate(migrations: MigrationVersionDefinition[], options?: MigrateOptions): Promise<void>;
}

export type TransactionDatabaseWrapper = RootDatabaseWrapper;

export type DatabaseWrapper = RootDatabaseWrapper;

interface QueryCallbacks {
  beforeQuery?: (query: string) => void;
  afterQuery?: (
    query: string,
    result: SqlRow[] | { rowsRead: number; rowsWritten: number },
  ) => void;
}

export interface MigrateOptions {
  beforeMigration?: (migrationsToApply: MigrationVersionDefinition[]) => void;
}

export interface MigrationVersionDefinition {
  name: string;
  beforeMigrate?: (db: DatabaseWrapper) => void;
  migrate: (db: DatabaseWrapper) => void;
  /**
   * Disable foreign key enforcement while this migration runs, restoring it afterward. Needed when
   * the migration rebuilds a table that is the parent of an `ON DELETE CASCADE` / `SET NULL` /
   * `SET DEFAULT` foreign key (e.g. via {@link alterTableColumns}); without this, dropping the
   * table during the rebuild would fire the cascade and delete or modify the referencing rows.
   *
   * Because enforcement is off, SQLite won't catch a dangling reference the migration introduces,
   * and re-enabling foreign keys doesn't re-validate existing rows — so the runner runs
   * `PRAGMA foreign_key_check` afterward and throws (without recording the migration) if the
   * migration left a violation.
   */
  disableForeignKeys?: boolean;
}

export function getMigrationStatus(
  storage: DurableObjectStorage,
  migrations: MigrationVersionDefinition[],
): {
  currentVersion: number;
  targetVersion: number;
  migrationsToApply: MigrationVersionDefinition[];
} {
  const currentVersion = getSchemaVersion(storage.sql);
  const targetVersion = migrations.length;
  const migrationsToApply = migrations.slice(currentVersion);
  return { currentVersion, targetVersion, migrationsToApply };
}

export function wrapDatabase(
  storage: DurableObjectStorage,
  options?: QueryCallbacks,
): RootDatabaseWrapper {
  return createWrapper(storage, options);
}

function createWrapper(
  storage: DurableObjectStorage,
  callbacks: QueryCallbacks | undefined,
): RootDatabaseWrapper {
  function queryCommon<TRow extends SqlRow>(statement: FragmentOrStatement): TRow[] {
    if ("build" in statement) {
      statement = statement.build();
    }
    callbacks?.beforeQuery?.(statement.query);
    const cursor = storage.sql.exec<TRow>(statement.query, ...(statement.values || []));
    const rows = cursor.toArray();
    callbacks?.afterQuery?.(statement.query, rows);
    return rows;
  }

  const wrapper: RootDatabaseWrapper = {
    storage: storage.sql,
    withCallbacks: (newCallbacks) => {
      return createWrapper(storage, { ...callbacks, ...newCallbacks });
    },
    transactionSync: <T>(fn: () => T): T => {
      return storage.transactionSync(fn);
    },
    migrate: (migrations, options) => migrateDatabase(storage, wrapper, migrations, options),
    pragma: (pragma) => {
      const query = `PRAGMA ${pragma}`;
      callbacks?.beforeQuery?.(query);
      const cursor = storage.sql.exec(query);
      const rows = cursor.toArray();
      const result = rows[0] ? (Object.values(rows[0])[0] as Primitive) : null;
      callbacks?.afterQuery?.(query, rows);
      return result;
    },
    pragmaFull: <TRow extends SqlRow>(pragma: string) => {
      const query = `PRAGMA ${pragma}`;
      callbacks?.beforeQuery?.(query);
      const cursor = storage.sql.exec<TRow>(query);
      const result = cursor.toArray();
      callbacks?.afterQuery?.(query, result);
      return result;
    },
    run: (statement) => {
      if ("build" in statement) {
        statement = statement.build();
      }
      callbacks?.beforeQuery?.(statement.query);

      // For write operations, we need to use exec and check the cursor metadata
      const cursor = storage.sql.exec(statement.query, ...(statement.values || []));

      const result = {
        rowsRead: cursor.rowsRead,
        rowsWritten: cursor.rowsWritten,
      };

      callbacks?.afterQuery?.(statement.query, result);
      return result;
    },
    queryNone: (statement) => {
      const rows = queryCommon(statement);
      if (rows.length > 0) {
        throw new Error(`Expected no rows, got ${rows.length}`);
      }
    },
    queryNoneOrOne: <TRow extends SqlRow>(statement: FragmentOrStatement) => {
      const rows = queryCommon<TRow>(statement);
      if (rows.length > 1) {
        throw new Error(`Expected at most one row, got ${rows.length}`);
      }
      return rows.length === 1 ? rows[0]! : null;
    },
    queryOne: <TRow extends SqlRow>(statement: FragmentOrStatement) => {
      const rows = queryCommon<TRow>(statement);
      if (rows.length !== 1) {
        throw new Error(`Expected one row, got ${rows.length}`);
      }
      return rows[0]!;
    },
    queryMany: <TRow extends SqlRow>(statement: FragmentOrStatement) => {
      return queryCommon<TRow>(statement);
    },
  };
  return wrapper;
}

function getSchemaVersion(sql: SqlStorage): number {
  sql.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value ANY) STRICT");

  const result = sql
    .exec<{ value: number }>('SELECT value FROM metadata WHERE key = "schema_version"')
    .toArray();
  if (result.length > 0 && typeof result[0]!.value !== "number") {
    throw new Error(
      `Invalid schema_version: ${result[0]!.value as string} (${typeof result[0]!.value})`,
    );
  }

  const currentVersion = result[0]?.value ?? 0;
  return currentVersion;
}

async function migrateDatabase(
  storage: DurableObjectStorage,
  db: RootDatabaseWrapper,
  versions: MigrationVersionDefinition[],
  options: MigrateOptions | undefined,
): Promise<void> {
  const initialVersion = getSchemaVersion(storage.sql);

  const finalTargetVersion = versions.length;
  if (initialVersion === finalTargetVersion) {
    return;
  }

  const migrationsToApply = versions.slice(initialVersion, finalTargetVersion);
  options?.beforeMigration?.(migrationsToApply);

  for (let version = initialVersion; version < versions.length; version++) {
    const definition = versions[version]!;
    const targetVersion = version + 1;

    console.log(`Migrating database to version ${targetVersion}: ${definition.name}...`);

    if (definition.disableForeignKeys) {
      await applyMigrationWithoutForeignKeys(storage, db, definition, targetVersion);
    } else {
      applyMigration(db, definition, targetVersion);
    }
  }
}

function applyMigration(
  db: RootDatabaseWrapper,
  definition: MigrationVersionDefinition,
  targetVersion: number,
  verifyBeforeRecording?: () => void,
): void {
  if (definition.beforeMigrate) {
    definition.beforeMigrate(db);
  }
  definition.migrate(db);

  // Hook for a `disableForeignKeys` migration to verify integrity *before* the migration is
  // recorded as applied, so a failure throws without recording it (see the foreign-key check).
  verifyBeforeRecording?.();

  db.run(sql`INSERT INTO metadata (key, value)
             VALUES ("schema_version", ${targetVersion})
             ON CONFLICT(key) DO UPDATE SET value = ${targetVersion}`);
}

async function applyMigrationWithoutForeignKeys(
  storage: DurableObjectStorage,
  db: RootDatabaseWrapper,
  definition: MigrationVersionDefinition,
  targetVersion: number,
): Promise<void> {
  // PRAGMA foreign_keys is a no-op while a transaction is open, and Durable Objects keeps an
  // implicit transaction open across statements. Commit it first so the toggle takes effect.
  await storage.sync();

  const foreignKeysEnabled = db.pragma("foreign_keys") === 1;
  if (foreignKeysEnabled) {
    db.run({ query: "PRAGMA foreign_keys = OFF" });
    if (db.pragma("foreign_keys") === 1) {
      throw new Error(
        `Migration "${definition.name}" set disableForeignKeys, but foreign keys could not be ` +
          `disabled because a transaction is open. Run migrations where no transaction is active, ` +
          `e.g. ctx.blockConcurrencyWhile(() => db.migrate(migrations)).`,
      );
    }
  }

  try {
    storage.transactionSync(() => {
      applyMigration(
        db,
        definition,
        targetVersion,
        foreignKeysEnabled ? () => assertNoForeignKeyViolations(db, definition.name) : undefined,
      );
    });
  } finally {
    if (foreignKeysEnabled) {
      // Ensure SQLite is outside the migration transaction so restoring enforcement is effective
      // even when the migration threw and the transaction rolled back.
      await storage.sync();
      db.run({ query: "PRAGMA foreign_keys = ON" });
      if (db.pragma("foreign_keys") !== 1) {
        throw new Error(
          `Migration "${definition.name}" applied, but foreign key enforcement could not be ` +
            `restored afterward because a transaction is open. Refusing to continue with foreign ` +
            `keys disabled. Run migrations where no transaction is active, e.g. ` +
            `ctx.blockConcurrencyWhile(() => db.migrate(migrations)).`,
        );
      }
    }
  }
}

/**
 * Throws if `PRAGMA foreign_key_check` reports any violations. Run after a `disableForeignKeys`
 * migration executes with enforcement off: re-enabling foreign keys does not re-validate existing
 * rows, so a migration that left a dangling reference would otherwise go undetected.
 */
function assertNoForeignKeyViolations(db: RootDatabaseWrapper, migrationName: string): void {
  const violations = db.pragmaFull<{ table: string }>("foreign_key_check");
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((violation) => violation.table))].join(", ");
    throw new Error(
      `Migration "${migrationName}" left ${violations.length} foreign key violation(s) (in: ` +
        `${tables}) while foreign keys were disabled. Aborting before committing — fix the ` +
        `migration so it preserves referential integrity.`,
    );
  }
}
