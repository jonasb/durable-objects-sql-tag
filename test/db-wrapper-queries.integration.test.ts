import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestContext } from "./test-helpers.js";

describe("DatabaseWrapper query operations", () => {
  const { urlWithInstance, insertTestUsers, cleanup } = createTestContext("test-queries");

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("queryOne", () => {
    test("returns a single row when exactly one row matches", async () => {
      const response = await SELF.fetch(urlWithInstance("/query-one"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      expect(response.status).toBe(200);
      const user: { rowid: number; name: string; email: string } = await response.json();
      expect(user).toMatchObject({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
      });
      expect(user.rowid).toBeTypeOf("number");
    });

    test("throws error when no rows match", async () => {
      const response = await SELF.fetch(urlWithInstance("/error-query-one-zero-rows"));

      expect(response.status).toBe(200);
      const data: { errorMessage: string } = await response.json();
      expect(data.errorMessage).toContain("Expected one row");
    });

    test("throws error when multiple rows match", async () => {
      const response = await SELF.fetch(urlWithInstance("/error-query-one-multiple-rows"));

      expect(response.status).toBe(200);
      const data: { errorMessage: string } = await response.json();
      expect(data.errorMessage).toContain("Expected one row");
    });
  });

  describe("queryNoneOrOne", () => {
    test("returns row when one row matches", async () => {
      // Insert a user first
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      const response = await SELF.fetch(urlWithInstance("/query-none-or-one"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "user1" }),
      });

      expect(response.status).toBe(200);
      const user = await response.json();
      expect(user).toMatchObject({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
      });
    });

    test("returns null when no rows match", async () => {
      const response = await SELF.fetch(urlWithInstance("/query-none-or-one"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "nonexistent" }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toBeNull();
    });
  });

  describe("queryMany", () => {
    test("returns all rows when query matches multiple rows", async () => {
      // Insert multiple users
      await insertTestUsers();

      const response = await SELF.fetch(urlWithInstance("/query-many"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      const users: { name: string }[] = await response.json();
      expect(users).toHaveLength(3);
      expect(users.map((u) => u.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    test("applies .map() transformation to results", async () => {
      // Insert multiple users
      await insertTestUsers();

      const response = await SELF.fetch(urlWithInstance("/sql-map"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      const users: { upperName: string; emailDomain: string }[] = await response.json();
      expect(users).toHaveLength(3);
      // Verify transformation was applied
      expect(users.map((u) => u.upperName)).toEqual(["ALICE", "BOB", "CHARLIE"]);
      expect(users.map((u) => u.emailDomain)).toEqual([
        "example.com",
        "example.com",
        "example.com",
      ]);
      // Original fields should not be present
      expect(users[0]).not.toHaveProperty("name");
      expect(users[0]).not.toHaveProperty("email");
    });

    test("returns empty array when no rows match", async () => {
      const response = await SELF.fetch(urlWithInstance("/query-many"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minRowid: 999 }),
      });

      expect(response.status).toBe(200);
      const users = await response.json();
      expect(users).toEqual([]);
    });

    test("returns filtered rows with WHERE clause", async () => {
      // Insert multiple users
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user2",
          name: "Bob",
          email: "bob@example.com",
        }),
      });

      // Query with minRowid filter (rowid >= 2 should only return Bob)
      const response = await SELF.fetch(urlWithInstance("/query-many"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minRowid: 2 }),
      });

      expect(response.status).toBe(200);
      const users: { name: string }[] = await response.json();
      expect(users).toHaveLength(1);
      expect(users[0]!.name).toBe("Bob");
    });
  });

  describe("queryNone", () => {
    test("executes INSERT without returning rows", async () => {
      const response = await SELF.fetch(urlWithInstance("/query-none"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      expect(response.status).toBe(200);
      const result: { success: boolean } = await response.json();
      expect(result.success).toBe(true);

      // Verify the user was actually inserted
      const verifyResponse = await SELF.fetch(urlWithInstance("/query-none-or-one"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "user1" }),
      });
      const user = await verifyResponse.json();
      expect(user).toMatchObject({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
      });
    });
  });

  describe("run", () => {
    test("returns rowsRead and rowsWritten after INSERT", async () => {
      const response = await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      expect(response.status).toBe(200);
      const result: { rowsRead: number; rowsWritten: number } = await response.json();
      expect(result.rowsRead).toBe(0); // No rows read for INSERT
      expect(result.rowsWritten).toBe(3); // 3 rows written (based on Cloudflare SqlStorage behavior)
    });

    test("returns correct changes for multiple INSERTs", async () => {
      // First insert
      const response1 = await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });
      const result1: { rowsRead: number; rowsWritten: number } = await response1.json();

      // Second insert
      const response2 = await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user2",
          name: "Bob",
          email: "bob@example.com",
        }),
      });
      const result2: { rowsRead: number; rowsWritten: number } = await response2.json();

      expect(result1.rowsRead).toBe(0);
      expect(result1.rowsWritten).toBe(3);
      expect(result2.rowsRead).toBe(0);
      expect(result2.rowsWritten).toBe(3);
    });
  });

  describe("pragma", () => {
    test("returns pragma table_info for users table", async () => {
      // Test PRAGMA table_info which is authorized in Durable Objects
      const response = await SELF.fetch(urlWithInstance("/pragma"));

      expect(response.status).toBe(200);
      const result: Array<{ name: string; type: string }> = await response.json();
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      // Should have columns from the users table
      expect(result.length).toBeGreaterThan(0);
      // Each column should have the table_info structure
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("type");
    });

    test("throws error for unauthorized PRAGMA user_version", async () => {
      // PRAGMA user_version is not authorized in Durable Objects for security reasons
      const response = await SELF.fetch(urlWithInstance("/error-pragma-unauthorized"));

      expect(response.status).toBe(200);
      const data: { errorMessage: string } = await response.json();
      expect(data.errorMessage).toBeDefined();
      // The error should indicate authorization failure
      expect(data.errorMessage.toLowerCase()).toContain("not authorized");
    });
  });
});
