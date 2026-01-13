import { describe, expect, test } from "vitest";
import { sql } from "../src/index.js";

describe("sql-tag", () => {
  test("no args", () => {
    expect(sql`SELECT * FROM hello`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * FROM hello",
        "values": undefined,
      }
    `);
  });

  test("one arg", () => {
    expect(sql`SELECT * FROM hello WHERE id = ${1}`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * FROM hello WHERE id = ?",
        "values": [
          1,
        ],
      }
    `);
  });

  test("multiple args", () => {
    expect(sql`SELECT * FROM hello WHERE id = ${1} AND name = ${"test"}`.build())
      .toMatchInlineSnapshot(`
      {
        "query": "SELECT * FROM hello WHERE id = ? AND name = ?",
        "values": [
          1,
          "test",
        ],
      }
    `);
  });

  test("nested tags literal", () => {
    expect(sql`INSERT INTO hello (id) VALUES (${sql`DEFAULT`})`.build()).toMatchInlineSnapshot(`
      {
        "query": "INSERT INTO hello (id) VALUES (DEFAULT)",
        "values": undefined,
      }
    `);
  });

  test("nested tags with values", () => {
    const subQuery = sql`SELECT id FROM users WHERE name = ${"John"}`;
    expect(sql`SELECT * FROM posts WHERE user_id IN (${subQuery})`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * FROM posts WHERE user_id IN (SELECT id FROM users WHERE name = ?)",
        "values": [
          "John",
        ],
      }
    `);
  });
});

describe("sql-tag isEmpty()", () => {
  test("no args", () => {
    expect(sql``.isEmpty()).toBe(true);
  });

  test("one string", () => {
    expect(sql`DEFAULT`.isEmpty()).toBe(false);
  });

  test("one arg", () => {
    expect(sql`SELECT * FROM hello WHERE id = ${1}`.isEmpty()).toBe(false);
  });
});

describe("sql-tag list", () => {
  test("one arg", () => {
    expect(sql`SELECT * WHERE id IN ${sql.list([1])}`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * WHERE id IN (?)",
        "values": [
          1,
        ],
      }
    `);
  });

  test("two args", () => {
    expect(sql`SELECT * WHERE id IN ${sql.list([1, 2])}`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * WHERE id IN (?, ?)",
        "values": [
          1,
          2,
        ],
      }
    `);
  });

  test("three args", () => {
    expect(sql`SELECT * WHERE id IN ${sql.list([1, 2, 3])}`.build()).toMatchInlineSnapshot(`
      {
        "query": "SELECT * WHERE id IN (?, ?, ?)",
        "values": [
          1,
          2,
          3,
        ],
      }
    `);
  });
});
