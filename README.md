# `durable-objects-sql-tag`

[![npm version](https://badge.fury.io/js/durable-objects-sql-tag.svg)](https://badge.fury.io/js/durable-objects-sql-tag)

A library for working with SQLite in [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

`npm install durable-objects-sql-tag`

- [Changelog](./CHANGELOG.md)

## Features

- Type-safe SQL template literals with parameterized queries
- Database wrapper with convenient query helpers (`queryOne`, `queryMany`, etc.)
- Built-in migration system with schema versioning
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
    this.db = wrapDatabase(ctx.storage, { migrations });
  }

  async fetch(request: Request): Promise<Response> {
    // Query a single row (throws if not exactly one row)
    const user = this.db.queryOne<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE id = ${userId}`
    );

    // Query zero or one row
    const maybeUser = this.db.queryNoneOrOne<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE id = ${userId}`
    );

    // Query multiple rows
    const users = this.db.queryMany<{ id: string; name: string }>(
      sql`SELECT * FROM users WHERE status = ${"active"}`
    );

    // Execute a write operation
    const { rowsRead, rowsWritten } = this.db.run(
      sql`INSERT INTO users (id, name, email) VALUES (${id}, ${name}, ${email})`
    );

    // Execute without expecting rows (throws if rows returned)
    this.db.queryNone(sql`DELETE FROM users WHERE id = ${userId}`);

    return new Response("OK");
  }
}
```

### Query Methods

| Method | Description |
|--------|-------------|
| `queryOne<T>(statement)` | Returns exactly one row. Throws if 0 or 2+ rows. |
| `queryNoneOrOne<T>(statement)` | Returns one row or `null`. Throws if 2+ rows. |
| `queryMany<T>(statement)` | Returns all matching rows as an array. |
| `queryNone(statement)` | Executes statement. Throws if any rows returned. |
| `run(statement)` | Executes statement. Returns `{ rowsRead, rowsWritten }`. |
| `pragma(name)` | Executes PRAGMA, returns single value. |
| `pragmaFull<T>(name)` | Executes PRAGMA, returns full result set. |
| `transactionSync(fn)` | Runs function in a synchronous transaction. |

### Migrations

Migrations run automatically when `wrapDatabase` is called. The system tracks applied migrations in a `metadata` table:

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

// Check migration status without applying
import { getMigrationStatus } from "durable-objects-sql-tag";
const { currentVersion, targetVersion, migrationsToApply } = getMigrationStatus(
  ctx.storage,
  migrations
);
```

### Query Callbacks

Add callbacks for logging or instrumentation:

```ts
const db = wrapDatabase(ctx.storage, {
  migrations,
  beforeQuery: (query) => console.log("Executing:", query),
  afterQuery: (query, result) => console.log("Result:", result),
  beforeMigration: (migrations) => console.log("Applying:", migrations),
});

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
