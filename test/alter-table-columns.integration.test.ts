import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { alterTableColumns, sql, wrapDatabase, type AlterTableColumnAction } from "../src/index.js";
import { createTestContext } from "./test-helpers.js";

const { urlWithInstance } = createTestContext("test-alter-table-columns");

interface AlterResult {
  schema: string;
  queries: string[];
  rows: Record<string, unknown>[];
}

async function alterTable(input: {
  tableName: string;
  createSql: string;
  actions: AlterTableColumnAction[];
  seedRows?: Record<string, unknown>[];
}): Promise<AlterResult> {
  const response = await SELF.fetch(urlWithInstance("/alter-table-columns"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  return response.json<AlterResult>();
}

describe("alterTableColumns", () => {
  test("adds a UNIQUE constraint", async () => {
    const { schema, queries } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT) STRICT",
      actions: [{ action: "addUnique", column: "name" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT',
    );
    // The core rebuild steps must run in this exact order. Other queries (child-FK detection, the
    // schema reads) are interleaved and asserted by behavior elsewhere, so filter to just these and
    // check the relative order rather than pinning the full sequence.
    const rebuildSteps = [
      "PRAGMA defer_foreign_keys = TRUE",
      "CREATE TABLE temp_alter_test (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT",
      'INSERT INTO "temp_alter_test" SELECT * FROM "alter_test"',
      'DROP TABLE "alter_test"',
      'ALTER TABLE "temp_alter_test" RENAME TO "alter_test"',
    ];
    expect(queries.filter((query) => rebuildSteps.includes(query))).toEqual(rebuildSteps);
  });

  test("adds a UNIQUE constraint on a quoted table name", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: 'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT) STRICT',
      actions: [{ action: "addUnique", column: "name" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT',
    );
  });

  test("drops a UNIQUE constraint", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT",
      actions: [{ action: "dropUnique", column: "name" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT) STRICT');
  });

  test("drops a UNIQUE constraint with a conflict clause", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT UNIQUE ON CONFLICT IGNORE) STRICT",
      actions: [{ action: "dropUnique", column: "name" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT) STRICT');
  });

  test("changes a column type", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER) STRICT",
      actions: [{ action: "changeType", column: "number", from: "INTEGER", to: "REAL" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number REAL) STRICT');
  });

  test("changes a column to a multi-token type", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, code TEXT)",
      actions: [{ action: "changeType", column: "code", from: "TEXT", to: "VARCHAR(255)" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, code VARCHAR(255))');
  });

  test("changes a multi-token column type, ignoring whitespace and case", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, amount DECIMAL(10, 2))",
      actions: [{ action: "changeType", column: "amount", from: "decimal(10,2)", to: "REAL" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, amount REAL)');
  });

  test("adds a NOT NULL constraint", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER) STRICT",
      actions: [{ action: "addNotNull", column: "number" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number INTEGER NOT NULL) STRICT',
    );
  });

  test("adds a NOT NULL constraint with a conflict clause", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER) STRICT",
      actions: [{ action: "addNotNull", column: "number", onConflict: "IGNORE" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number INTEGER NOT NULL ON CONFLICT IGNORE) STRICT',
    );
  });

  test("drops a NOT NULL constraint", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER NOT NULL) STRICT",
      actions: [{ action: "dropNotNull", column: "number" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number INTEGER) STRICT',
    );
  });

  test("drops a NOT NULL constraint with a conflict clause", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER NOT NULL ON CONFLICT IGNORE) STRICT",
      actions: [{ action: "dropNotNull", column: "number" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number INTEGER) STRICT',
    );
  });

  test("drops a NOT NULL constraint while keeping a foreign key reference", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER, recurse_fk INTEGER NOT NULL REFERENCES alter_test(id)) STRICT",
      actions: [{ action: "dropNotNull", column: "recurse_fk" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number INTEGER, recurse_fk INTEGER REFERENCES alter_test(id)) STRICT',
    );
  });

  test("preserves existing data through the rebuild", async () => {
    const { rows } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT) STRICT",
      actions: [{ action: "addNotNull", column: "name" }],
      seedRows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });

    expect(rows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  test("recreates associated indexes", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT);\nCREATE INDEX alter_test_name ON alter_test (name)",
      actions: [{ action: "addNotNull", column: "name" }],
    });

    expect(schema).toContain(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
    );
    expect(schema).toContain("CREATE INDEX alter_test_name ON alter_test (name)");
  });

  test("recreates associated triggers", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT, touched INTEGER);\n" +
        "CREATE TRIGGER alter_test_touch AFTER UPDATE ON alter_test BEGIN" +
        " UPDATE alter_test SET touched = 1 WHERE id = NEW.id; END",
      actions: [{ action: "addNotNull", column: "name" }],
    });

    expect(schema).toContain("CREATE TRIGGER alter_test_touch");
    expect(schema).toContain("UPDATE ON alter_test");
  });

  test("handles a table name that requires quoting", async () => {
    const { schema, rows } = await alterTable({
      tableName: "order",
      createSql: 'CREATE TABLE "order" (id INTEGER PRIMARY KEY, total INTEGER) STRICT',
      actions: [{ action: "addNotNull", column: "total" }],
      seedRows: [{ id: 1, total: 42 }],
    });

    expect(schema).toBe(
      'CREATE TABLE "order" (id INTEGER PRIMARY KEY, total INTEGER NOT NULL) STRICT',
    );
    expect(rows).toEqual([{ id: 1, total: 42 }]);
  });

  test("does not split column definitions on commas inside string literals", async () => {
    const { schema, rows } = await alterTable({
      tableName: "alter_test",
      createSql:
        "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'a,b') STRICT",
      actions: [{ action: "addNotNull", column: "label" }],
      seedRows: [{ id: 1, label: "x,y" }],
    });

    expect(schema).toBe(
      `CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'a,b' NOT NULL) STRICT`,
    );
    expect(rows).toEqual([{ id: 1, label: "x,y" }]);
  });

  test("matches a column name that requires quoting", async () => {
    const { schema, rows } = await alterTable({
      tableName: "alter_test",
      createSql: 'CREATE TABLE alter_test (id INTEGER PRIMARY KEY, "display name" TEXT) STRICT',
      actions: [{ action: "addNotNull", column: "display name" }],
      seedRows: [{ id: 1, "display name": "Ada" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, "display name" TEXT NOT NULL) STRICT',
    );
    expect(rows).toEqual([{ id: 1, "display name": "Ada" }]);
  });

  test("matches a column name case-insensitively", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, Name TEXT) STRICT",
      actions: [{ action: "addNotNull", column: "name" }],
    });

    expect(schema).toBe(
      'CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, Name TEXT NOT NULL) STRICT',
    );
  });

  test("throws when the column does not exist", async () => {
    const response = await SELF.fetch(urlWithInstance("/alter-table-columns"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tableName: "alter_test",
        createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, name TEXT) STRICT",
        actions: [{ action: "addNotNull", column: "missing" }],
      }),
    });

    expect(response.status).toBe(500);
    const { error } = await response.json<{ error: string }>();
    expect(error).toContain("Column not found: missing");
  });

  // Regression: rebuilding a table that is the *parent* of an ON DELETE CASCADE foreign key would
  // silently delete the child rows (the DROP fires the cascade, and foreign keys can't be disabled
  // on Durable Objects). Refuse instead, and leave the data untouched. Run directly against the
  // storage so we can set up the foreign key relationship.
  test("refuses to rebuild a parent of an ON DELETE CASCADE foreign key, leaving data intact", async () => {
    const id = env.TEST_DURABLE_OBJECT.idFromName(`cascade-${Date.now()}`);
    const stub = env.TEST_DURABLE_OBJECT.get(id);

    const result = await runInDurableObject(stub, (_instance, state) => {
      const db = wrapDatabase(state.storage);
      db.run({ query: "PRAGMA foreign_keys = ON" });
      db.run(sql`CREATE TABLE parent (rowid INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT`);
      db.run(sql`
        CREATE TABLE child (
          rowid INTEGER PRIMARY KEY,
          parent_rowid INTEGER REFERENCES parent(rowid) ON DELETE CASCADE,
          note TEXT NOT NULL
        ) STRICT
      `);
      db.run(sql`INSERT INTO parent VALUES (1, 'p')`);
      db.run(sql`INSERT INTO child VALUES (10, 1, 'keep me')`);

      let error: string | null = null;
      try {
        alterTableColumns(db, "parent", [{ action: "dropNotNull", column: "name" }]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      return {
        error,
        childCount: db.queryOne<{ count: number }>(sql`SELECT count(*) AS count FROM child`).count,
        parentName: db.queryOne<{ name: string | null }>(
          sql`SELECT name FROM parent WHERE rowid = 1`,
        ).name,
      };
    });

    expect(result.error).toContain('Cannot rebuild "parent"');
    expect(result.error).toContain("ON DELETE CASCADE");
    expect(result.childCount).toBe(1); // child rows untouched
    expect(result.parentName).toBe("p"); // parent unchanged (NOT NULL constraint still present)
  });

  // Even a plain (NO ACTION) reference can't tolerate the rebuild while FK enforcement is on — it
  // fails the foreign key check at commit — so refuse with the same guidance rather than erroring.
  test("refuses to rebuild a table referenced by a plain (NO ACTION) foreign key", async () => {
    const id = env.TEST_DURABLE_OBJECT.idFromName(`noaction-${Date.now()}`);
    const stub = env.TEST_DURABLE_OBJECT.get(id);

    const error = await runInDurableObject(stub, (_instance, state) => {
      const db = wrapDatabase(state.storage);
      db.run({ query: "PRAGMA foreign_keys = ON" });
      db.run(sql`CREATE TABLE par (rowid INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT`);
      db.run(sql`
        CREATE TABLE chi (rowid INTEGER PRIMARY KEY, p INTEGER REFERENCES par(rowid), note TEXT NOT NULL) STRICT
      `);
      try {
        alterTableColumns(db, "par", [{ action: "dropNotNull", column: "name" }]);
        return "did not throw";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });

    expect(error).toContain('Cannot rebuild "par"');
    expect(error).toContain("disableForeignKeys");
  });

  // The escape hatch: a migration that sets `disableForeignKeys` can rebuild a cascade parent.
  // The runner disables foreign keys around it (so the cascade doesn't fire), then restores them.
  test("a disableForeignKeys migration rebuilds a cascade parent, preserving children and restoring FK", async () => {
    const id = env.TEST_DURABLE_OBJECT.idFromName(`fk-migration-${Date.now()}`);
    const stub = env.TEST_DURABLE_OBJECT.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = wrapDatabase(state.storage);
      db.run({ query: "PRAGMA foreign_keys = ON" });
      db.run(sql`CREATE TABLE doc (rowid INTEGER PRIMARY KEY, title TEXT NOT NULL) STRICT`);
      db.run(sql`
        CREATE TABLE doc_event (
          rowid INTEGER PRIMARY KEY,
          doc INTEGER REFERENCES doc(rowid) ON DELETE CASCADE,
          body TEXT NOT NULL
        ) STRICT
      `);
      db.run(sql`INSERT INTO doc VALUES (1, 'title')`);
      db.run(sql`INSERT INTO doc_event VALUES (10, 1, 'keep me')`);

      // The TestDurableObject constructor already migrated to version 2, so this migration sits at
      // index 2; the first two entries are placeholders that won't re-run.
      const noop = { name: "already applied", migrate() {} };
      await db.migrate([
        noop,
        noop,
        {
          name: "Make doc.title optional",
          disableForeignKeys: true,
          migrate(db) {
            alterTableColumns(db, "doc", [{ action: "dropNotNull", column: "title" }]);
          },
        },
      ]);

      return {
        foreignKeys: db.pragma("foreign_keys"),
        childCount: db.queryOne<{ count: number }>(sql`SELECT count(*) AS count FROM doc_event`)
          .count,
        docSql: db.queryOne<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'doc'`,
        ).sql,
      };
    });

    expect(result.childCount).toBe(1); // cascade did not fire
    expect(result.docSql).toContain("title TEXT)"); // NOT NULL dropped
    expect(result.foreignKeys).toBe(1); // enforcement restored after the migration
  });

  // A disableForeignKeys migration runs with enforcement off, so SQLite won't catch a dangling
  // reference the migration introduces — and re-enabling foreign keys doesn't re-validate existing
  // rows. The runner runs `foreign_key_check` and refuses to record the migration if it left a
  // violation, rather than silently committing corrupt data.
  test("a disableForeignKeys migration that leaves a dangling reference throws and is not recorded", async () => {
    const id = env.TEST_DURABLE_OBJECT.idFromName(`fk-violation-${Date.now()}`);
    const stub = env.TEST_DURABLE_OBJECT.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const db = wrapDatabase(state.storage);
      db.run({ query: "PRAGMA foreign_keys = ON" });
      db.run(sql`CREATE TABLE doc (rowid INTEGER PRIMARY KEY, title TEXT NOT NULL) STRICT`);
      db.run(sql`
        CREATE TABLE doc_event (
          rowid INTEGER PRIMARY KEY,
          doc INTEGER REFERENCES doc(rowid) ON DELETE CASCADE,
          body TEXT NOT NULL
        ) STRICT
      `);

      const noop = { name: "already applied", migrate() {} };
      let error: string | null = null;
      try {
        await db.migrate([
          noop,
          noop,
          {
            name: "Insert an orphan event",
            disableForeignKeys: true,
            migrate(db) {
              // doc 999 does not exist; with foreign keys off this insert succeeds.
              db.run(sql`INSERT INTO doc_event VALUES (10, 999, 'orphan')`);
            },
          },
        ]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      return {
        error,
        foreignKeys: db.pragma("foreign_keys"),
        orphanCount: db.queryOne<{ count: number }>(
          sql`SELECT count(*) AS count FROM doc_event WHERE doc = 999`,
        ).count,
        // The TestDurableObject constructor already migrated to version 2; the failed migration
        // (version 3) must not have advanced it.
        schemaVersion: db.queryOne<{ value: number }>(
          sql`SELECT value FROM metadata WHERE key = "schema_version"`,
        ).value,
      };
    });

    expect(result.error).toContain("foreign key violation");
    expect(result.error).toContain("doc_event");
    expect(result.foreignKeys).toBe(1); // enforcement restored even after the error was caught
    expect(result.orphanCount).toBe(0); // failed migration writes were rolled back
    expect(result.schemaVersion).toBe(2); // not recorded as applied
  });
});

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_DURABLE_OBJECT: DurableObjectNamespace;
    }
  }
}
