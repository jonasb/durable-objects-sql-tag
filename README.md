# `durable-objects-sql-tag`

[![npm version](https://badge.fury.io/js/durable-objects-sql-tag.svg)](https://badge.fury.io/js/durable-objects-sql-tag)

A library for working with SQLite in [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

`npm install durable-objects-sql-tag`

- [Changelog](./CHANGELOG.md)

## Features

- Type-safe SQL template literals with parameterized queries
- Database wrapper with convenient query helpers (`queryOne`, `queryMany`, etc.)
- Built-in migration system with schema versioning
- Column alterations (add/drop `NOT NULL` and `UNIQUE`, change type) via automatic table rebuilds
- SQL injection prevention through proper parameterization
- Support for all SQLite types including binary data (ArrayBuffer, Uint8Array)

## Usage

### Basic SQL Tag

The `sql` template literal builds parameterized SQL queries:

```ts
import { sql } from "durable-objects-sql-tag";

// Simple query with parameters
const query = sql`SELECT * FROM users WHERE id = ${userId}`;
const { query: sqlString, values } = query.build();
// sqlString: "SELECT * FROM users WHERE id = ?"
// values: [userId]

// Using sql.join() for IN clauses
const ids = [1, 2, 3];
const listQuery = sql`SELECT * FROM users WHERE id IN (${sql.join(ids)})`;
// Builds: "SELECT * FROM users WHERE id IN (?, ?, ?)"

// Composing fragments
const whereClause = sql`WHERE status = ${"active"}`;
const fullQuery = sql`SELECT * FROM users ${whereClause}`;
```

### Database Wrapper

The `wrapDatabase` function provides a convenient API for executing queries:

```ts
import { DurableObject } from "cloudflare:workers";
import { sql, wrapDatabase, type MigrationVersionDefinition } from "durable-objects-sql-tag";

const migrations: MigrationVersionDefinition[] = [
  {
    name: "Create users table",
    migrate(db) {
      db.run(sql`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE
        ) STRICT
      `);
    },
  },
];

export class MyDurableObject extends DurableObject {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = wrapDatabase(ctx.storage);
    // Migrations run asynchronously; block requests until they finish.
    ctx.blockConcurrencyWhile(() => this.db.migrate(migrations));
  }

  async fetch(request: Request): Promise<Response> {
    // Query a single row (throws if not exactly one row)
    const user = this.db.queryOne<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE id = ${userId}`,
    );

    // Query zero or one row
    const maybeUser = this.db.queryNoneOrOne<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE id = ${userId}`,
    );

    // Query multiple rows
    const users = this.db.queryMany<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE status = ${"active"}`,
    );

    // Execute a write operation
    const { rowsRead, rowsWritten } = this.db.run(
      sql`INSERT INTO users (id, name, email) VALUES (${id}, ${name}, ${email})`,
    );

    // Execute without expecting rows (throws if rows returned)
    this.db.queryNone(sql`DELETE FROM users WHERE id = ${userId}`);

    return new Response("OK");
  }
}
```

### Query Methods

| Method                         | Description                                              |
| ------------------------------ | -------------------------------------------------------- |
| `queryOne<T>(statement)`       | Returns exactly one row. Throws if 0 or 2+ rows.         |
| `queryNoneOrOne<T>(statement)` | Returns one row or `null`. Throws if 2+ rows.            |
| `queryMany<T>(statement)`      | Returns all matching rows as an array.                   |
| `queryNone(statement)`         | Executes statement. Throws if any rows returned.         |
| `run(statement)`               | Executes statement. Returns `{ rowsRead, rowsWritten }`. |
| `pragma(name)`                 | Executes PRAGMA, returns single value.                   |
| `pragmaFull<T>(name)`          | Executes PRAGMA, returns full result set.                |
| `transactionSync(fn)`          | Runs function in a synchronous transaction.              |

### Migrations

Call `db.migrate(migrations)` to apply pending migrations. It is **async** (see
[Altering Columns](#altering-columns) for why), so run it where you can await — typically
`ctx.blockConcurrencyWhile` in the Durable Object constructor, which also ensures requests wait
until migrations finish. The applied version is tracked in a `metadata` table.

```ts
const migrations: MigrationVersionDefinition[] = [
  {
    name: "Initial schema",
    migrate(db) {
      db.run(sql`CREATE TABLE users (...) STRICT`);
    },
  },
  {
    name: "Add posts table",
    beforeMigrate(db) {
      // Optional: run before migration
    },
    migrate(db) {
      db.run(sql`CREATE TABLE posts (...) STRICT`);
    },
  },
];

// In the Durable Object constructor:
this.db = wrapDatabase(ctx.storage);
ctx.blockConcurrencyWhile(() => this.db.migrate(migrations));

// Check migration status without applying
import { getMigrationStatus } from "durable-objects-sql-tag";
const { currentVersion, targetVersion, migrationsToApply } = getMigrationStatus(
  ctx.storage,
  migrations,
);
```

### Altering Columns

SQLite's `ALTER TABLE` can only add, drop, and rename whole columns. To add or drop a `NOT NULL` or
`UNIQUE` constraint, or change a column's type, the table has to be rebuilt. `alterTableColumns`
performs that [12-step rebuild](https://sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes)
for you — preserving the table's data along with its indexes and triggers — and is meant to be used
inside a migration:

```ts
import { sql, alterTableColumns, type MigrationVersionDefinition } from "durable-objects-sql-tag";

const migrations: MigrationVersionDefinition[] = [
  {
    name: "Create users table",
    migrate(db) {
      db.run(sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL) STRICT`);
    },
  },
  {
    name: "Make email optional and unique",
    migrate(db) {
      alterTableColumns(db, "users", [
        { action: "dropNotNull", column: "email" },
        { action: "addUnique", column: "email" },
      ]);
    },
  },
];
```

Supported actions:

| Action                                          | Description                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ action: "addNotNull", column, onConflict? }` | Add a `NOT NULL` constraint (with an optional `ON CONFLICT` clause: `ROLLBACK`, `ABORT`, `FAIL`, `IGNORE`, or `REPLACE`).                                                |
| `{ action: "dropNotNull", column }`             | Remove a `NOT NULL` constraint.                                                                                                                                          |
| `{ action: "addUnique", column }`               | Add a `UNIQUE` constraint.                                                                                                                                               |
| `{ action: "dropUnique", column }`              | Remove a `UNIQUE` constraint.                                                                                                                                            |
| `{ action: "changeType", column, from, to }`    | Change a column's type. `from` must match the current type (matched ignoring case and whitespace) and may span multiple tokens, e.g. `from: "VARCHAR(255)", to: "TEXT"`. |

The rebuild runs inside a synchronous transaction and sets `PRAGMA defer_foreign_keys = TRUE` so
that foreign key constraints aren't tripped mid-rebuild; they are still checked when the transaction
commits.

> **Foreign keys:** `alterTableColumns` rebuilds the table by dropping and recreating it. If another
> table references it via a foreign key, that can't be done while foreign keys are enforced — an
> `ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT` action would fire and change the referencing rows, and
> even a plain `NO ACTION` reference fails the foreign key check at commit. Disabling foreign keys
> (`PRAGMA foreign_keys = OFF`) prevents this, but it's a no-op while a transaction is open, and
> Durable Objects keeps an implicit transaction open across statements — so it can only be toggled
> after committing via `storage.sync()`. That's why migrations are async: set
> **`disableForeignKeys: true`** on the migration and the runner commits, disables foreign keys
> around it, then restores them:
>
> ```ts
> {
>   name: "Make orders.customer_id optional",
>   disableForeignKeys: true,
>   migrate(db) {
>     alterTableColumns(db, "orders", [{ action: "dropNotNull", column: "customer_id" }]);
>   },
> }
> ```
>
> Without `disableForeignKeys`, `alterTableColumns` **throws** (rather than silently losing data or
> failing at commit) when it detects another table referencing the one being rebuilt. Tables that
> aren't referenced by any other table — and self-references — need no flag.
>
> **Atomicity:** toggling foreign keys requires committing, so a `disableForeignKeys` migration
> commits any earlier pending migrations before it runs and commits its own changes before the next
> one — a batch that includes such a migration is therefore _not_ applied as a single transaction.
> Each migration is still recorded only after it succeeds, and its own changes roll back if it
> throws, so a failed run leaves the schema at the last fully-applied version and can be retried.

### Query Callbacks

Add callbacks for logging or instrumentation:

```ts
const db = wrapDatabase(ctx.storage, {
  beforeQuery: (query) => console.log("Executing:", query),
  afterQuery: (query, result) => console.log("Result:", result),
});

// `beforeMigration` is a migrate option, not a query callback:
ctx.blockConcurrencyWhile(() =>
  db.migrate(migrations, {
    beforeMigration: (migrations) => console.log("Applying:", migrations),
    // The library never logs on its own — use `onMigrate` to log each migration:
    onMigrate: ({ targetVersion, definition }) =>
      console.log(`Migrating database to version ${targetVersion}: ${definition.name}...`),
  }),
);

// Or add callbacks to an existing wrapper
const dbWithLogging = db.withCallbacks({
  beforeQuery: (query) => console.log(query),
});
```

### Supported Types

**Input types (Primitive):**

- `string`
- `number`
- `boolean` (stored as `"true"`/`"false"` strings)
- `null`
- `undefined` (stored as `null`)
- `ArrayBuffer`
- `Uint8Array`

**Output types (SqlStorageValue):**

- `string`
- `number`
- `null`
- `ArrayBuffer`

## License

[MIT](./LICENSE.txt)
