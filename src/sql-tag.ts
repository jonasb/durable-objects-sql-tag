import type { SqlStorageValue } from "@cloudflare/workers-types";

/**
 * Primitive types that can be used as parameters in SQL queries.
 * These are INPUT types - some convert during storage:
 * - boolean → "true"/"false" strings
 * - undefined → null
 * - Uint8Array → works, returned as ArrayBuffer
 *
 * OUTPUT types (what SQLite returns) are defined by SqlStorageValue:
 * string | number | null | ArrayBuffer
 */
export type Primitive = string | number | boolean | null | undefined | ArrayBuffer | Uint8Array;

export interface SqlQueryFragment {
  build(): PreparedStatement;
  isEmpty(): boolean;
  templateStrings: TemplateStringsArray | string[];
  templateValues: (Primitive | SqlQueryFragment)[];
}

export interface PreparedStatement {
  query: string;
  values?: Primitive[];
}

/**
 * Row type returned from SQL queries.
 * Uses SqlStorageValue (OUTPUT types): string | number | null | ArrayBuffer
 */
export type SqlRow = Record<string, SqlStorageValue>;

interface SqlTag {
  (
    templateStrings: TemplateStringsArray,
    ...templateValues: (Primitive | SqlQueryFragment)[]
  ): SqlQueryFragment;
  list: (values: Primitive[]) => SqlQueryFragment;
}

const sql: SqlTag = (templateStrings, ...templateValues) => {
  const fragment = {
    build() {
      return expandTemplate(templateStrings, templateValues);
    },
    isEmpty() {
      return isTemplateEmpty(templateStrings, templateValues);
    },
    templateStrings,
    templateValues,
  };
  return fragment;
};

sql.list = (values: Primitive[]) => {
  // Handle empty arrays by generating (NULL) which will never match
  if (values.length === 0) {
    const templateStrings: string[] = ["(NULL)"];
    const templateValues: Primitive[] = [];
    return {
      build() {
        return { query: "(NULL)", values: [] };
      },
      isEmpty() {
        return false;
      },
      templateStrings,
      templateValues,
    };
  }

  const templateStrings: string[] = [
    "(",
    ...(Array(values.length - 1).fill(", ") as string[]),
    ")",
  ];
  const templateValues = values;
  return {
    build() {
      return expandTemplate(templateStrings, templateValues);
    },
    isEmpty() {
      return isTemplateEmpty(templateStrings, templateValues);
    },
    templateStrings,
    templateValues,
  };
};

function isTemplateEmpty(
  templateStrings: TemplateStringsArray | string[],
  templateValues: (Primitive | SqlQueryFragment)[],
) {
  return (
    templateStrings.length === 1 && templateStrings[0]!.length === 0 && templateValues.length === 0
  );
}

function expandTemplate(
  rootTemplateStrings: TemplateStringsArray | string[],
  rootTemplateValues: (Primitive | SqlQueryFragment)[],
): PreparedStatement {
  let query = "";
  const values: Primitive[] = [];

  function expand(
    templateStrings: TemplateStringsArray | string[],
    templateValues: (Primitive | SqlQueryFragment)[],
  ) {
    for (let i = 0; i < templateStrings.length; i++) {
      if (i > 0) {
        const value = templateValues[i - 1]!;
        const valueIsFragment =
          value &&
          typeof value === "object" &&
          "templateStrings" in value &&
          "templateValues" in value;

        if (valueIsFragment) {
          expand(value.templateStrings, value.templateValues);
        } else {
          query += "?";
          values.push(value);
        }
      }
      query += templateStrings[i];
    }
  }

  expand(rootTemplateStrings, rootTemplateValues);

  return { query, values: values.length > 0 ? values : undefined };
}

export { sql };
