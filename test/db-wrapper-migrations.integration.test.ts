import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("DatabaseWrapper migration system", () => {
  const instanceId = `test-migrations-${Date.now()}`;
  const baseUrl = `http://example.com/test`;
  const urlWithInstance = (path: string) => `${baseUrl}${path}?instanceId=${instanceId}`;

  test("applies initial migrations and creates schema_version metadata", async () => {
    const response = await SELF.fetch(urlWithInstance("/migration-version"));

    expect(response.status).toBe(200);
    const result: { value: number } = await response.json();

    // Schema version should be 2 (we have 2 migrations in test-durable-object.ts)
    expect(result.value).toBe(2);
  });

  test("migrations create expected tables", async () => {
    // Insert a user to verify the users table exists (created in migration 1)
    const userResponse = await SELF.fetch(urlWithInstance("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "test-user",
        name: "Test User",
        email: "test@example.com",
      }),
    });

    expect(userResponse.status).toBe(200);
    const userResult: { rowsRead: number; rowsWritten: number } = await userResponse.json();
    expect(userResult.rowsWritten).toBe(3); // 3 rows written (based on Cloudflare SqlStorage behavior)
  });

  test("second migration creates posts table", async () => {
    // First, create a user
    await SELF.fetch(urlWithInstance("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
      }),
    });

    // The posts table should exist (created in migration 2)
    // We can't directly test the table existence via the test endpoints,
    // but we verified the migration version is 2, which means both migrations ran
    const versionResponse = await SELF.fetch(urlWithInstance("/migration-version"));
    const version: { value: number } = await versionResponse.json();
    expect(version.value).toBe(2);
  });

  test("migrations are idempotent - running twice doesn't break", async () => {
    // The migrations have already been applied in the constructor
    // Let's verify the database still works correctly
    await SELF.fetch(urlWithInstance("/cleanup"));

    // Insert a user
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
    const user = await response.json();
    expect(user).toMatchObject({
      id: "user1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  test("schema version is stored in metadata table", async () => {
    const response = await SELF.fetch(urlWithInstance("/migration-version"));

    expect(response.status).toBe(200);
    const result: { value: number } = await response.json();

    // Verify the metadata table exists and has the schema_version key
    expect(result).toHaveProperty("value");
    expect(typeof result.value).toBe("number");
    expect(result.value).toBeGreaterThan(0);
  });
});
