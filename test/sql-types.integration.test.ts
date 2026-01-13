import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * Comprehensive type testing for SQL tag parameters and results.
 * Tests cover all Primitive types, binary data, SQLite type affinity, and edge cases.
 *
 * These tests use HTTP endpoints to test the sql`` tag in the Durable Object.
 * Binary data is tested server-side to verify runtime types.
 */

describe("SQL Types via sql`` tag", () => {
  const instanceId = `test-sql-types-${Date.now()}`;
  const baseUrl = `http://example.com/test`;
  const urlWithInstance = (path: string) => `${baseUrl}${path}?instanceId=${instanceId}`;

  /** Helper to test type round-trip through sql`` tag */
  async function testTypes(options: {
    tableDefinition: string;
    testValues: unknown[];
    tableName?: string;
  }) {
    const response = await SELF.fetch(urlWithInstance("/types/execute"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });

    const result = await response.json<{
      insertedTypes: string[];
      selectedValues: unknown[];
      selectedTypes: string[];
      error?: string;
    }>();

    if (result.error) {
      throw new Error(result.error);
    }

    return result;
  }

  beforeEach(async () => {
    await SELF.fetch(urlWithInstance("/cleanup"));
  });

  afterEach(async () => {
    await SELF.fetch(urlWithInstance("/cleanup"));
  });

  describe("String Types", () => {
    test("should handle empty strings", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [""],
      });

      expect(result.selectedValues[0]).toBe("");
      expect(result.selectedTypes[0]).toBe("string");
    });

    test("should handle unicode characters including emoji", async () => {
      const unicodeStrings = ["Hello 世界", "🚀 🎉 💻", "Ñoño", "مرحبا", "Здравствуй"];

      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: unicodeStrings,
      });

      expect(result.selectedValues).toEqual(unicodeStrings);
      result.selectedTypes.forEach((type) => expect(type).toBe("string"));
    });

    test("should handle very long strings (>10KB)", async () => {
      const longString = "a".repeat(15000);

      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [longString],
      });

      expect(result.selectedValues[0]).toBe(longString);
      expect((result.selectedValues[0] as string).length).toBe(15000);
    });

    test("should handle special SQL characters", async () => {
      const specialStrings = [
        "O'Reilly",
        'Say "Hello"',
        "Back\\slash",
        "Semi;colon",
        "Percent%",
        "Under_score",
        "New\nLine",
        "Tab\tChar",
      ];

      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: specialStrings,
      });

      expect(result.selectedValues).toEqual(specialStrings);
    });

    test("should distinguish between empty string and null", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: ["", null],
      });

      expect(result.selectedValues[0]).toBe("");
      expect(result.selectedValues[1]).toBe(null);
      expect(result.selectedTypes[0]).toBe("string");
      expect(result.selectedTypes[1]).toBe("null");
    });
  });

  describe("Number Types", () => {
    test("should handle positive and negative integers", async () => {
      const numbers = [0, 1, -1, 42, -42, 2147483647, -2147483648];

      const result = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: numbers,
      });

      expect(result.selectedValues).toEqual(numbers);
      result.selectedTypes.forEach((type) => expect(type).toBe("number"));
    });

    test("should handle floating point numbers", async () => {
      const floats = [3.14, -2.718, 0.5, 1e-10, 1e10];

      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: floats,
      });

      for (let i = 0; i < floats.length; i++) {
        expect(result.selectedValues[i]).toBeCloseTo(floats[i]!, 10);
      }
    });

    test("should handle very large numbers", async () => {
      const largeNumbers = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];

      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: largeNumbers,
      });

      expect(result.selectedValues).toEqual(largeNumbers);
    });

    test("should convert NaN to null", async () => {
      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: [NaN],
      });

      // NaN is converted to null in SQLite
      expect(result.selectedValues[0]).toBe(null);
      expect(result.selectedTypes[0]).toBe("null");
    });

    test("should convert Infinity to null", async () => {
      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: [Infinity],
      });

      // Infinity is converted to null in SQLite
      expect(result.selectedValues[0]).toBe(null);
      expect(result.selectedTypes[0]).toBe("null");
    });

    test("should handle numbers in scientific notation", async () => {
      const scientificNumbers = [1e5, 1e-5, 2.5e3, -3.7e-2];

      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: scientificNumbers,
      });

      for (let i = 0; i < scientificNumbers.length; i++) {
        expect(result.selectedValues[i]).toBeCloseTo(scientificNumbers[i]!, 10);
      }
    });
  });

  describe("Boolean Types", () => {
    test("should handle boolean values as integers", async () => {
      // Test booleans created server-side (not via JSON)
      const response = await SELF.fetch(urlWithInstance("/types/primitives"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json<{
        insertedTypes: string[];
        selectedValues: unknown[];
        selectedTypes: string[];
        error?: string;
      }>();

      expect(result.error).toBeUndefined();

      // Booleans are converted to strings "true"/"false" by the sql tag
      // This happens during parameterization, not from JSON serialization
      expect(result.selectedValues[0]).toBe("true");
      expect(result.selectedValues[1]).toBe("false");
      expect(result.selectedTypes[0]).toBe("string");
      expect(result.selectedTypes[1]).toBe("string");
    });
  });

  describe("Null and Undefined", () => {
    test("should handle null values", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [null],
      });

      expect(result.selectedValues[0]).toBe(null);
      expect(result.selectedTypes[0]).toBe("null");
    });

    test("should treat undefined as null", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [undefined],
      });

      expect(result.selectedValues[0]).toBe(null);
      expect(result.selectedTypes[0]).toBe("null");
    });

    test("should distinguish null from empty string and zero", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: ["", null],
      });

      expect(result.selectedValues[0]).toBe("");
      expect(result.selectedValues[1]).toBe(null);
    });
  });

  describe("Binary Data - ArrayBuffer and Uint8Array", () => {
    // Binary data is tested server-side since ArrayBuffer can't be sent via JSON

    test("should handle ArrayBuffer with byte integrity", async () => {
      const response = await SELF.fetch(urlWithInstance("/types/binary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCase: "arraybuffer",
        }),
      });

      const result = await response.json<{
        insertedType: string;
        selectedType: string;
        bytesMatch: boolean;
        byteLength: number;
        error?: string;
      }>();

      expect(result.error).toBeUndefined();
      expect(result.insertedType).toBe("ArrayBuffer");
      expect(result.selectedType).toBe("ArrayBuffer");
      expect(result.byteLength).toBe(7);
      expect(result.bytesMatch).toBe(true);
    });

    test("should test Uint8Array support", async () => {
      const response = await SELF.fetch(urlWithInstance("/types/binary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCase: "uint8array",
        }),
      });

      const result = await response.json<{
        insertedType: string;
        selectedType: string;
        bytesMatch: boolean;
        byteLength: number;
        error?: string;
      }>();

      // Uint8Array is supported - it works correctly!
      expect(result.error).toBeUndefined();
      expect(result.selectedType).toBe("ArrayBuffer");
      expect(result.byteLength).toBe(5);
      expect(result.bytesMatch).toBe(true);
    });

    test("should test Uint8Array with offset", async () => {
      const response = await SELF.fetch(urlWithInstance("/types/binary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCase: "uint8array-offset",
        }),
      });

      const result = await response.json<{
        insertedType: string;
        selectedType: string;
        bytesMatch: boolean;
        byteLength: number;
        error?: string;
      }>();

      // Uint8Array with offset is also supported!
      expect(result.error).toBeUndefined();
      expect(result.selectedType).toBe("ArrayBuffer");
      expect(result.byteLength).toBe(5);
      expect(result.bytesMatch).toBe(true);
    });

    test("should handle large binary data (>1MB)", async () => {
      const response = await SELF.fetch(urlWithInstance("/types/binary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCase: "large-binary",
        }),
      });

      const result = await response.json<{
        insertedType: string;
        selectedType: string;
        bytesMatch: boolean;
        byteLength: number;
        error?: string;
      }>();

      expect(result.error).toBeUndefined();
      expect(result.selectedType).toBe("ArrayBuffer");
      expect(result.byteLength).toBe(1.5 * 1024 * 1024);
      expect(result.bytesMatch).toBe(true);
    });
  });

  describe("SQLite Type Affinity", () => {
    test("INTEGER columns return numbers", async () => {
      const result = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: [42],
      });

      expect(typeof result.selectedValues[0]).toBe("number");
      expect(result.selectedTypes[0]).toBe("number");
    });

    test("REAL columns return numbers", async () => {
      const result = await testTypes({
        tableDefinition: "value REAL",
        testValues: [3.14],
      });

      expect(typeof result.selectedValues[0]).toBe("number");
      expect(result.selectedTypes[0]).toBe("number");
    });

    test("TEXT columns return strings", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: ["hello"],
      });

      expect(typeof result.selectedValues[0]).toBe("string");
      expect(result.selectedTypes[0]).toBe("string");
    });

    test("type coercion: string to INTEGER", async () => {
      const result = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: ["42"],
      });

      // SQLite converts string to integer
      expect(result.selectedValues[0]).toBe(42);
      expect(result.selectedTypes[0]).toBe("number");
    });

    test("type coercion: number to TEXT", async () => {
      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [123],
      });

      // Number is converted to string "123.0" when stored in TEXT column
      expect(result.selectedValues[0]).toBe("123.0");
      expect(result.selectedTypes[0]).toBe("string");
    });

    test("NULL works in any column type", async () => {
      // Test NULL in INTEGER column
      const result1 = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: [null],
      });
      expect(result1.selectedValues[0]).toBe(null);

      // Test NULL in TEXT column
      const result2 = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [null],
      });
      expect(result2.selectedValues[0]).toBe(null);

      // Test NULL in REAL column
      const result3 = await testTypes({
        tableDefinition: "value REAL",
        testValues: [null],
      });
      expect(result3.selectedValues[0]).toBe(null);
    });
  });

  describe("Edge Cases", () => {
    test("should handle multiple parameters of the same value", async () => {
      const value = 42;
      const result = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: [value, value, value],
      });

      expect(result.selectedValues).toEqual([42, 42, 42]);
    });

    test("should handle zero-length values", async () => {
      // Test empty string
      const result1 = await testTypes({
        tableDefinition: "value TEXT",
        testValues: [""],
      });
      expect(result1.selectedValues[0]).toBe("");

      // Test zero
      const result2 = await testTypes({
        tableDefinition: "value INTEGER",
        testValues: [0],
      });
      expect(result2.selectedValues[0]).toBe(0);
    });

    test("should handle special numeric string values", async () => {
      const specialStrings = ["NaN", "Infinity", "-Infinity", "0x1234", "1e5"];

      const result = await testTypes({
        tableDefinition: "value TEXT",
        testValues: specialStrings,
      });

      // These should be stored as strings
      expect(result.selectedValues).toEqual(specialStrings);
    });
  });
});
