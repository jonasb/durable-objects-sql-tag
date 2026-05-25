import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { AlterTableColumnAction } from "../src/index.js";
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
    expect(queries).toEqual([
      "PRAGMA defer_foreign_keys = TRUE",
      "SELECT type, sql FROM sqlite_master WHERE tbl_name = ?",
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      "CREATE TABLE temp_alter_test (id INTEGER PRIMARY KEY, name TEXT UNIQUE) STRICT",
      "INSERT INTO temp_alter_test SELECT * FROM alter_test",
      "DROP TABLE alter_test",
      "ALTER TABLE temp_alter_test RENAME TO alter_test",
    ]);
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

  test("changes a column type", async () => {
    const { schema } = await alterTable({
      tableName: "alter_test",
      createSql: "CREATE TABLE alter_test (id INTEGER PRIMARY KEY, number INTEGER) STRICT",
      actions: [{ action: "changeType", column: "number", from: "INTEGER", to: "REAL" }],
    });

    expect(schema).toBe('CREATE TABLE "alter_test" (id INTEGER PRIMARY KEY, number REAL) STRICT');
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
});
