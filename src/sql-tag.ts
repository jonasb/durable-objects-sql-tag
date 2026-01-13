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

export interface SqlQueryFragment<TRow extends SqlRow = SqlRow> {
  build(): PreparedStatement;
  isEmpty(): boolean;
  map<U extends SqlRow>(mapper: (row: TRow) => U): MappedSqlQueryFragment<TRow, U>;
  templateStrings: TemplateStringsArray | string[];
  templateValues: (Primitive | SqlQueryFragment)[];
}

export interface MappedSqlQueryFragment<TRaw extends SqlRow, TMapped extends SqlRow>
  extends Omit<SqlQueryFragment<TMapped>, "map"> {
  mapper: (row: TRaw) => TMapped;
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
  join: (values: Primitive[]) => SqlQueryFragment;
}

const sql: SqlTag = (templateStrings, ...templateValues) => {
  const fragment: SqlQueryFragment = {
    build() {
      return expandTemplate(templateStrings, templateValues);
    },
    isEmpty() {
      return isTemplateEmpty(templateStrings, templateValues);
    },
    map<U extends SqlRow>(mapper: (row: SqlRow) => U): MappedSqlQueryFragment<SqlRow, U> {
      return {
        build: fragment.build,
        isEmpty: fragment.isEmpty,
        templateStrings: fragment.templateStrings,
        templateValues: fragment.templateValues,
        mapper,
      };
    },
    templateStrings,
    templateValues,
  };
  return fragment;
};

sql.join = (values: Primitive[]): SqlQueryFragment => {
  // Handle empty arrays by generating NULL which will never match
  if (values.length === 0) {
    const templateStrings: string[] = ["NULL"];
    const templateValues: Primitive[] = [];
    const fragment: SqlQueryFragment = {
      build() {
        return { query: "NULL" };
      },
      isEmpty() {
        return false;
      },
      map<U extends SqlRow>(mapper: (row: SqlRow) => U): MappedSqlQueryFragment<SqlRow, U> {
        return {
          build: fragment.build,
          isEmpty: fragment.isEmpty,
          templateStrings: fragment.templateStrings,
          templateValues: fragment.templateValues,
          mapper,
        };
      },
      templateStrings,
      templateValues,
    };
    return fragment;
  }

  // Create templateStrings: ["", ", ", ", ", ""] with length = values.length + 1
  const templateStrings: string[] = [""];
  for (let i = 1; i < values.length; i++) {
    templateStrings.push(", ");
  }
  templateStrings.push("");

  const fragment: SqlQueryFragment = {
    build() {
      return expandTemplate(templateStrings, values);
    },
    isEmpty() {
      return isTemplateEmpty(templateStrings, values);
    },
    map<U extends SqlRow>(mapper: (row: SqlRow) => U): MappedSqlQueryFragment<SqlRow, U> {
      return {
        build: fragment.build,
        isEmpty: fragment.isEmpty,
        templateStrings: fragment.templateStrings,
        templateValues: fragment.templateValues,
        mapper,
      };
    },
    templateStrings,
    templateValues: values,
  };
  return fragment;
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
