import { DurableObject } from "cloudflare:workers";
import {
  sql,
  wrapDatabase,
  type MigrationVersionDefinition,
  type Primitive,
  type RootDatabaseWrapper,
} from "../src/index.js";

interface Env {
  TEST_DURABLE_OBJECT: DurableObjectNamespace<TestDurableObject>;
}

interface DB {
  metadata: {
    key: string;
    value: string | number;
  };
  users: {
    rowid: number;
    id: string;
    name: string;
    email: string;
  };
  posts: {
    rowid: number;
    user_id: string;
    title: string;
    content: string;
    created_at: number;
  };
}

const migrations: MigrationVersionDefinition[] = [
  {
    name: "Initial schema",
    migrate(db) {
      db.run(sql`
        CREATE TABLE users (
          rowid INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE
        ) STRICT
      `);
    },
  },
  {
    name: "Add posts table",
    migrate(db) {
      db.run(sql`
        CREATE TABLE posts (
          rowid INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        ) STRICT
      `);
    },
  },
];

export class TestDurableObject extends DurableObject {
  private db: RootDatabaseWrapper;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = wrapDatabase(ctx.storage, { migrations });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Query operations
      if (path === "/test/query-one") {
        return await this.testQueryOne(request);
      }
      if (path === "/test/query-none-or-one") {
        return await this.testQueryNoneOrOne(request);
      }
      if (path === "/test/query-many") {
        return await this.testQueryMany(request);
      }
      if (path === "/test/query-none") {
        return await this.testQueryNone(request);
      }
      if (path === "/test/run") {
        return await this.testRun(request);
      }

      // SQL tag operations
      if (path === "/test/sql-params") {
        return await this.testSqlParams(request);
      }
      if (path === "/test/sql-list") {
        return await this.testSqlList(request);
      }
      if (path === "/test/sql-fragments") {
        return await this.testSqlFragments(request);
      }

      // Migration operations
      if (path === "/test/migration-version") {
        return this.testMigrationVersion();
      }
      if (path === "/test/pragma") {
        return this.testPragma();
      }

      // Error handling
      if (path === "/test/error-pragma-unauthorized") {
        return this.testErrorPragmaUnauthorized();
      }
      if (path === "/test/error-query-one-zero-rows") {
        return this.testErrorQueryOneZeroRows();
      }
      if (path === "/test/error-query-one-multiple-rows") {
        return this.testErrorQueryOneMultipleRows();
      }

      // Cleanup
      if (path === "/test/cleanup") {
        return this.cleanup();
      }

      // Type testing endpoints
      if (path === "/test/types/execute") {
        return await this.testTypesExecute(request);
      }
      if (path === "/test/types/binary") {
        return await this.testTypesBinary(request);
      }
      if (path === "/test/types/primitives") {
        return this.testTypesPrimitives();
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Test endpoint error:", error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  private async testQueryOne(request: Request): Promise<Response> {
    const body = await request.json<{ id: string; name: string; email: string }>();
    this.db.run(sql`
      INSERT INTO users (id, name, email)
      VALUES (${body.id}, ${body.name}, ${body.email})
    `);

    const user = this.db.queryOne(sql`SELECT * FROM users WHERE id = ${body.id}`);
    return new Response(JSON.stringify(user), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testQueryNoneOrOne(request: Request): Promise<Response> {
    const body = await request.json<{ id: string }>();
    const user = this.db.queryNoneOrOne(sql`SELECT * FROM users WHERE id = ${body.id}`);
    return new Response(JSON.stringify(user), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testQueryMany(request: Request): Promise<Response> {
    const body = await request.json<{ minRowid?: number }>();
    const query = body.minRowid
      ? sql`SELECT * FROM users WHERE rowid >= ${body.minRowid}`
      : sql`SELECT * FROM users`;

    const users = this.db.queryMany<DB["users"]>(query);
    return new Response(JSON.stringify(users), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testQueryNone(request: Request): Promise<Response> {
    const body = await request.json<{ id: string; name: string; email: string }>();
    this.db.queryNone(sql`
      INSERT INTO users (id, name, email)
      VALUES (${body.id}, ${body.name}, ${body.email})
    `);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testRun(request: Request): Promise<Response> {
    const body = await request.json<{ id: string; name: string; email: string }>();
    const result = this.db.run(sql`
      INSERT INTO users (id, name, email)
      VALUES (${body.id}, ${body.name}, ${body.email})
    `);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testSqlParams(request: Request): Promise<Response> {
    const body = await request.json<{ id: string; name: string }>();
    // Insert a user with parameterized query
    this.db.run(sql`
      INSERT INTO users (id, name, email)
      VALUES (${body.id}, ${body.name}, ${body.id + "@example.com"})
    `);
    const user = this.db.queryOne(sql`SELECT * FROM users WHERE id = ${body.id}`);
    return new Response(JSON.stringify(user), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testSqlList(request: Request): Promise<Response> {
    const body = await request.json<{ ids: string[] }>();
    const users = this.db.queryMany(sql`
      SELECT * FROM users WHERE id IN ${sql.list(body.ids)}
    `);
    return new Response(JSON.stringify(users), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async testSqlFragments(request: Request): Promise<Response> {
    const body = await request.json<{ orderBy?: "name" | "email" }>();
    // Since sql.identifier doesn't exist, we'll manually construct the query
    let query: ReturnType<typeof sql>;
    if (body.orderBy === "name") {
      query = sql`SELECT * FROM users ORDER BY name`;
    } else if (body.orderBy === "email") {
      query = sql`SELECT * FROM users ORDER BY email`;
    } else {
      query = sql`SELECT * FROM users`;
    }
    const users = this.db.queryMany(query);
    return new Response(JSON.stringify(users), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private testMigrationVersion(): Response {
    const version = this.db.queryOne(sql`
      SELECT value FROM metadata WHERE key = 'schema_version'
    `);
    return new Response(JSON.stringify(version), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private testPragma(): Response {
    // Use PRAGMA table_info which is authorized in Durable Objects
    const result = this.db.pragmaFull("table_info(users)");
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private testErrorPragmaUnauthorized(): Response {
    try {
      // PRAGMA user_version is not authorized in Durable Objects
      this.db.pragmaFull("user_version");
      return new Response(JSON.stringify({ error: "Should have thrown" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  private testErrorQueryOneZeroRows(): Response {
    try {
      this.db.queryOne(sql`SELECT * FROM users WHERE id = 'nonexistent'`);
      return new Response(JSON.stringify({ error: "Should have thrown" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  private testErrorQueryOneMultipleRows(): Response {
    // Insert multiple users
    this.db.run(
      sql`INSERT INTO users (id, name, email) VALUES ('user1', 'User 1', 'user1@example.com')`,
    );
    this.db.run(
      sql`INSERT INTO users (id, name, email) VALUES ('user2', 'User 2', 'user2@example.com')`,
    );

    try {
      // This should throw because it returns multiple rows
      this.db.queryOne(sql`SELECT * FROM users`);
      return new Response(JSON.stringify({ error: "Should have thrown" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  private cleanup(): Response {
    this.db.queryNone(sql`DELETE FROM posts`);
    this.db.queryNone(sql`DELETE FROM users`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Test primitive types that can't be properly sent via JSON (booleans, etc.)
   * Creates primitives server-side to test actual SQL tag behavior.
   */
  private testTypesPrimitives(): Response {
    try {
      // Create table
      this.db.run(sql`CREATE TABLE test_primitives (value INTEGER)`);

      // Create actual boolean primitives server-side (not JSON strings)
      const boolTrue: boolean = true;
      const boolFalse: boolean = false;

      // Insert using sql`` tag
      this.db.run(sql`INSERT INTO test_primitives (value) VALUES (${boolTrue as Primitive})`);
      this.db.run(sql`INSERT INTO test_primitives (value) VALUES (${boolFalse as Primitive})`);

      // Select back
      const rows = this.db.queryMany<{ value: number | string }>(
        sql`SELECT value FROM test_primitives ORDER BY rowid`,
      );

      const results = {
        insertedTypes: ["boolean", "boolean"],
        selectedValues: rows.map((r) => r.value),
        selectedTypes: rows.map((r) => typeof r.value),
      };

      // Cleanup
      this.db.run(sql`DROP TABLE test_primitives`);

      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      // Cleanup on error
      try {
        this.db.run(sql`DROP TABLE IF EXISTS test_primitives`);
      } catch {
        // Ignore cleanup errors
      }

      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 500,
        },
      );
    }
  }

  /**
   * Test binary data types (ArrayBuffer, Uint8Array) server-side.
   * Creates binary data in the DO to test actual runtime behavior.
   */
  private async testTypesBinary(request: Request): Promise<Response> {
    try {
      const body = await request.json<{
        testCase: "arraybuffer" | "uint8array" | "uint8array-offset" | "large-binary";
      }>();

      // Create table for binary testing
      this.db.run(sql`CREATE TABLE test_binary (data BLOB)`);

      const testResult: {
        testCase: string;
        insertedType: string;
        selectedType: string;
        bytesMatch: boolean;
        byteLength: number;
        error?: string;
      } = {
        testCase: body.testCase,
        insertedType: "",
        selectedType: "",
        bytesMatch: false,
        byteLength: 0,
      };

      try {
        if (body.testCase === "arraybuffer") {
          // Test ArrayBuffer
          const bytes = [0, 1, 127, 128, 255, 42, 69];
          const buffer = new ArrayBuffer(bytes.length);
          const view = new Uint8Array(buffer);
          bytes.forEach((b, i) => (view[i] = b));

          testResult.insertedType = "ArrayBuffer";

          // Insert using sql`` tag;
          this.db.run(sql`INSERT INTO test_binary (data) VALUES (${buffer as Primitive})`);

          // Select using sql`` tag
          const rows = this.db.queryMany<{ data: ArrayBuffer }>(sql`SELECT data FROM test_binary`);

          const retrieved = rows[0]!.data;
          testResult.selectedType =
            retrieved instanceof ArrayBuffer ? "ArrayBuffer" : typeof retrieved;
          testResult.byteLength = retrieved instanceof ArrayBuffer ? retrieved.byteLength : 0;

          // Check byte-by-byte equality
          if (retrieved instanceof ArrayBuffer) {
            const retrievedView = new Uint8Array(retrieved);
            testResult.bytesMatch = bytes.every((b, i) => retrievedView[i] === b);
          }
        } else if (body.testCase === "uint8array") {
          // Test Uint8Array
          const bytes = new Uint8Array([10, 20, 30, 40, 50]);

          testResult.insertedType = "Uint8Array";

          try {
            // Try to insert Uint8Array using sql`` tag
            this.db.run(sql`INSERT INTO test_binary (data) VALUES (${bytes as Primitive})`);

            // Select back
            const rows = this.db.queryMany(sql`SELECT data FROM test_binary`);

            const retrieved = rows[0]!.data;
            testResult.selectedType =
              retrieved instanceof ArrayBuffer ? "ArrayBuffer" : typeof retrieved;
            testResult.byteLength = retrieved instanceof ArrayBuffer ? retrieved.byteLength : 0;

            // Check byte-by-byte equality
            if (retrieved instanceof ArrayBuffer) {
              const retrievedView = new Uint8Array(retrieved);
              testResult.bytesMatch = Array.from(bytes).every((b, i) => retrievedView[i] === b);
            }
          } catch (error) {
            testResult.error = `Uint8Array not supported: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else if (body.testCase === "uint8array-offset") {
          // Test Uint8Array with offset
          const largeBuffer = new ArrayBuffer(10);
          const largeView = new Uint8Array(largeBuffer);
          for (let i = 0; i < 10; i++) {
            largeView[i] = i;
          }

          // Create a view of bytes 3-7
          const sliceView = new Uint8Array(largeBuffer, 3, 5);

          testResult.insertedType = "Uint8Array (with offset)";

          try {
            this.db.run(sql`INSERT INTO test_binary (data) VALUES (${sliceView as Primitive})`);

            const rows = this.db.queryMany(sql`SELECT data FROM test_binary`);

            const retrieved = rows[0]!.data;
            testResult.selectedType =
              retrieved instanceof ArrayBuffer ? "ArrayBuffer" : typeof retrieved;
            testResult.byteLength = retrieved instanceof ArrayBuffer ? retrieved.byteLength : 0;

            // Should contain bytes [3, 4, 5, 6, 7]
            if (retrieved instanceof ArrayBuffer) {
              const retrievedView = new Uint8Array(retrieved);
              testResult.bytesMatch =
                retrievedView.length === 5 && retrievedView.every((b, i) => b === i + 3);
            }
          } catch (error) {
            testResult.error = `Uint8Array with offset not supported: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else if (body.testCase === "large-binary") {
          // Test large binary data (> 1MB)
          const size = 1.5 * 1024 * 1024; // 1.5MB
          const buffer = new ArrayBuffer(size);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < size; i++) {
            view[i] = i % 256;
          }

          testResult.insertedType = "ArrayBuffer (1.5MB)";

          this.db.run(sql`INSERT INTO test_binary (data) VALUES (${buffer as Primitive})`);

          const rows = this.db.queryMany(sql`SELECT data FROM test_binary`);

          const retrieved = rows[0]!.data;
          testResult.selectedType =
            retrieved instanceof ArrayBuffer ? "ArrayBuffer" : typeof retrieved;
          testResult.byteLength = retrieved instanceof ArrayBuffer ? retrieved.byteLength : 0;

          // Spot check pattern integrity
          if (retrieved instanceof ArrayBuffer) {
            const retrievedView = new Uint8Array(retrieved);
            let matches = true;
            for (let i = 0; i < size; i += 10000) {
              if (retrievedView[i] !== i % 256) {
                matches = false;
                break;
              }
            }
            testResult.bytesMatch = matches && retrievedView.length === size;
          }
        }

        // Cleanup
        this.ctx.storage.sql.exec("DROP TABLE test_binary");

        return new Response(JSON.stringify(testResult), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (innerError) {
        // Cleanup on error
        try {
          this.ctx.storage.sql.exec("DROP TABLE IF EXISTS test_binary");
        } catch {
          // Ignore cleanup errors
        }

        testResult.error = innerError instanceof Error ? innerError.message : String(innerError);
        return new Response(JSON.stringify(testResult), {
          headers: { "Content-Type": "application/json" },
          status: 400,
        });
      }
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 500,
        },
      );
    }
  }

  /**
   * Generic endpoint for type testing using sql`` tag.
   * Tests parameter handling and result types through the sql tag.
   * Uses direct SQL for DDL, sql`` tag for data operations.
   */
  private async testTypesExecute(request: Request): Promise<Response> {
    const body = await request.json<{
      tableDefinition: string; // e.g., "value TEXT" or "data BLOB"
      testValues: unknown[]; // Values to insert and test
      tableName?: string; // Optional, defaults to "test_types"
    }>();

    const tableName = body.tableName || "test_types";

    const results: {
      insertedTypes: string[];
      selectedValues: unknown[];
      selectedTypes: string[];
      error?: string;
    } = {
      insertedTypes: [],
      selectedValues: [],
      selectedTypes: [],
    };

    try {
      // Create table using direct SQL (DDL doesn't need parameterization)
      this.ctx.storage.sql.exec(`CREATE TABLE ${tableName} (${body.tableDefinition})`);

      // Capture types of values being inserted
      results.insertedTypes = body.testValues.map((v) => {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        if (v instanceof ArrayBuffer) return "ArrayBuffer";
        if (v instanceof Uint8Array) return "Uint8Array";
        return typeof v;
      });

      // Insert each value using sql`` tag (THIS is what we're testing - parameter handling)
      for (const value of body.testValues) {
        this.db.run(sql`INSERT INTO test_types VALUES (${value as Primitive})`);
      }

      // Select data using sql`` tag
      const rows = this.db.queryMany(sql`SELECT * FROM test_types`);

      // Capture the selected values and their runtime types
      results.selectedValues = rows.map((row) => Object.values(row)[0]);
      results.selectedTypes = results.selectedValues.map((v) => {
        if (v === null) return "null";
        if (v instanceof ArrayBuffer) return "ArrayBuffer";
        return typeof v;
      });

      // Cleanup using direct SQL
      this.ctx.storage.sql.exec(`DROP TABLE ${tableName}`);

      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      // Attempt cleanup on error
      try {
        this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${tableName}`);
      } catch {
        // Ignore cleanup errors
      }

      results.error = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      });
    }
  }
}
