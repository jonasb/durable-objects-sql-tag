import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import {
  sql,
  type MappedSqlQueryFragment,
  type PreparedStatement,
  type Primitive,
  type SqlQueryFragment,
  type SqlRow,
} from "./sql-tag.js";

type FragmentOrStatement =
  | PreparedStatement
  | SqlQueryFragment
  | MappedSqlQueryFragment<SqlRow, SqlRow>;

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
}

export type TransactionDatabaseWrapper = RootDatabaseWrapper;

export type DatabaseWrapper = RootDatabaseWrapper;

interface Options extends QueryCallbacks {
  beforeMigration?: (migrationsToApply: MigrationVersionDefinition[]) => void;
  migrations?: MigrationVersionDefinition[];
}

interface QueryCallbacks {
  beforeQuery?: (query: string) => void;
  afterQuery?: (
    query: string,
    result: SqlRow[] | { rowsRead: number; rowsWritten: number },
  ) => void;
}

export interface MigrationVersionDefinition {
  name: string;
  beforeMigrate?: (db: DatabaseWrapper) => void;
  migrate: (db: DatabaseWrapper) => void;
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
  options?: Options,
): RootDatabaseWrapper {
  const wrapper = createWrapper(storage, options);

  if (options?.migrations) {
    migrateDatabase(wrapper, options.migrations, options);
  }

  return wrapper;
}

function createWrapper(
  storage: DurableObjectStorage,
  callbacks: QueryCallbacks | undefined,
): RootDatabaseWrapper {
  function queryCommon<TRow extends SqlRow>(statement: FragmentOrStatement): TRow[] {
    // Extract mapper if present (for MappedSqlQueryFragment)
    const mapper = "mapper" in statement ? (statement.mapper as (row: SqlRow) => TRow) : null;

    if ("build" in statement) {
      statement = statement.build();
    }
    callbacks?.beforeQuery?.(statement.query);
    const cursor = storage.sql.exec<TRow>(statement.query, ...(statement.values || []));
    let rows = cursor.toArray();
    callbacks?.afterQuery?.(statement.query, rows);

    // Apply mapper if present
    if (mapper) {
      rows = rows.map(mapper) as TRow[];
    }

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

function migrateDatabase(
  db: RootDatabaseWrapper,
  versions: MigrationVersionDefinition[],
  options: Options,
) {
  const initialVersion = getSchemaVersion(db.storage);

  const finalTargetVersion = versions.length;
  if (initialVersion === finalTargetVersion) {
    return;
  }

  const migrationsToApply = versions.slice(initialVersion, finalTargetVersion);
  options.beforeMigration?.(migrationsToApply);

  for (let version = initialVersion; version < versions.length; version++) {
    const definition = versions[version]!;
    const targetVersion = version + 1;

    console.log(`Migrating database to version ${targetVersion}: ${definition.name}...`);

    if (definition.beforeMigrate) {
      definition.beforeMigrate(db);
    }
    definition.migrate(db);

    db.run(sql`INSERT INTO metadata (key, value)
               VALUES ("schema_version", ${targetVersion})
               ON CONFLICT(key) DO UPDATE SET value = ${targetVersion}`);
  }
}
