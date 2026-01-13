import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestContext } from "./test-helpers.js";

describe("SQL tag integration with real SqlStorage", () => {
  const { urlWithInstance, insertTestUsers, cleanup } = createTestContext("test-sql-tag");

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("parameterized queries", () => {
    test("correctly substitutes parameters in INSERT and SELECT", async () => {
      const response = await SELF.fetch(urlWithInstance("/sql-params"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user-123",
          name: "Alice Smith",
        }),
      });

      expect(response.status).toBe(200);
      const user = await response.json();
      expect(user).toMatchObject({
        id: "user-123",
        name: "Alice Smith",
        email: "user-123@example.com",
      });
    });

    test("handles special characters in parameters", async () => {
      const response = await SELF.fetch(urlWithInstance("/sql-params"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user-special",
          name: "Alice O'Brien & <Bob>",
        }),
      });

      expect(response.status).toBe(200);
      const user: { name: string } = await response.json();
      expect(user.name).toBe("Alice O'Brien & <Bob>");
    });

    test("handles numbers as parameters", async () => {
      // First create a user
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      // Query by rowid (number parameter)
      const response = await SELF.fetch(urlWithInstance("/query-many"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minRowid: 1 }),
      });

      expect(response.status).toBe(200);
      const users: { name: string }[] = await response.json();
      expect(users.length).toBeGreaterThan(0);
    });
  });

  describe("sql.join() with IN clause", () => {
    test("filters rows using IN clause with multiple values", async () => {
      // Insert multiple users
      await insertTestUsers();

      // Query using IN clause
      const response = await SELF.fetch(urlWithInstance("/sql-list"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["user1", "user3"] }),
      });

      expect(response.status).toBe(200);
      const users: { name: string }[] = await response.json();
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.name).sort()).toEqual(["Alice", "Charlie"]);
    });

    test("handles empty array in IN clause", async () => {
      const response = await SELF.fetch(urlWithInstance("/sql-list"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      });

      expect(response.status).toBe(200);
      const users = await response.json();
      expect(users).toEqual([]);
    });

    test("handles single value in IN clause", async () => {
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "single-user",
          name: "Single User",
          email: "single@example.com",
        }),
      });

      const response = await SELF.fetch(urlWithInstance("/sql-list"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["single-user"] }),
      });

      expect(response.status).toBe(200);
      const users: { name: string }[] = await response.json();
      expect(users).toHaveLength(1);
      expect(users[0]!.name).toBe("Single User");
    });
  });

  describe("SQL fragments", () => {
    test("composes queries with optional ORDER BY clause", async () => {
      // Insert users
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user1",
          name: "Charlie",
          email: "charlie@example.com",
        }),
      });
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user2",
          name: "Alice",
          email: "alice@example.com",
        }),
      });
      await SELF.fetch(urlWithInstance("/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "user3",
          name: "Bob",
          email: "bob@example.com",
        }),
      });

      // Query without ORDER BY
      const response1 = await SELF.fetch(urlWithInstance("/sql-fragments"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response1.status).toBe(200);
      const users1 = await response1.json();
      expect(users1).toHaveLength(3);

      // Query with ORDER BY name
      const response2 = await SELF.fetch(urlWithInstance("/sql-fragments"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderBy: "name" }),
      });
      expect(response2.status).toBe(200);
      const users2: { name: string }[] = await response2.json();
      expect(users2).toHaveLength(3);
      expect(users2.map((u) => u.name)).toEqual(["Alice", "Bob", "Charlie"]);

      // Query with ORDER BY email
      const response3 = await SELF.fetch(urlWithInstance("/sql-fragments"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderBy: "email" }),
      });
      expect(response3.status).toBe(200);
      const users3: { name: string }[] = await response3.json();
      expect(users3).toHaveLength(3);
      expect(users3.map((u) => u.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });
  });

  describe("SQL injection prevention", () => {
    test("prevents SQL injection through parameterized queries", async () => {
      // Try to inject SQL through a parameter
      const maliciousName = "'; DROP TABLE users; --";

      const response = await SELF.fetch(urlWithInstance("/sql-params"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "malicious-user",
          name: maliciousName,
        }),
      });

      expect(response.status).toBe(200);
      const user: { name: string } = await response.json();
      // The malicious string should be stored as-is, not executed
      expect(user.name).toBe(maliciousName);

      // Verify the users table still exists by querying it
      const verifyResponse = await SELF.fetch(urlWithInstance("/query-many"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(verifyResponse.status).toBe(200);
      const users: { name: string }[] = await verifyResponse.json();
      expect(users.length).toBeGreaterThan(0);
    });
  });
});
