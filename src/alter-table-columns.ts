import type { DatabaseWrapper } from "./db-wrapper.js";
import { sql } from "./sql-tag.js";

export type AlterTableColumnAction =
  | { action: "addUnique"; column: string }
  | { action: "dropUnique"; column: string }
  | { action: "changeType"; column: string; from: string; to: string }
  | {
      action: "addNotNull";
      column: string;
      onConflict?: "ROLLBACK" | "ABORT" | "FAIL" | "IGNORE" | "REPLACE";
    }
  | { action: "dropNotNull"; column: string };

/**
 * Alter columns of an existing table by rebuilding it. SQLite's `ALTER TABLE` can only add or drop
 * whole columns and rename them; it can't add/drop constraints such as `NOT NULL` or `UNIQUE` or
 * change a column's type. This helper performs the full table rebuild documented at
 * https://sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes, preserving
 * the table's data and its associated indexes and triggers.
 *
 * Intended to be used inside a migration's `migrate(db)` function, for example:
 *
 * ```ts
 * {
 *   name: "Make email optional",
 *   migrate(db) {
 *     alterTableColumns(db, "users", [{ action: "dropNotNull", column: "email" }]);
 *   },
 * }
 * ```
 *
 * The rebuild runs inside a synchronous transaction. Foreign key enforcement is deferred until the
 * transaction commits (`PRAGMA defer_foreign_keys = TRUE`) so that dropping and recreating the
 * table doesn't trip foreign key constraints mid-rebuild.
 */
export function alterTableColumns(
  db: DatabaseWrapper,
  tableName: string,
  actions: AlterTableColumnAction[],
): void {
  db.transactionSync(() => {
    // Following https://sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
    // Defer foreign key enforcement until the transaction commits. PRAGMA foreign_keys cannot be
    // changed inside a transaction, so the documented "disable foreign_keys" step is replaced with
    // defer_foreign_keys, which has the same effect for the duration of the transaction.
    db.run({ query: "PRAGMA defer_foreign_keys = TRUE" });

    const tempTableName = `temp_${tableName}`;

    // Remember the indexes and triggers associated with the table so they can be recreated, since
    // dropping the table also drops them.
    const schema = db.queryMany<{ type: string; sql: string | null }>(
      sql`SELECT type, sql FROM sqlite_master WHERE tbl_name = ${tableName}`,
    );

    // Construct the new table in the desired revised format under a temporary name.
    const { sql: tableSql } = db.queryOne<{ sql: string }>(
      sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`,
    );
    const updatedTableSql = modifyTableSql(tableName, tempTableName, tableSql, actions);
    db.run({ query: updatedTableSql });

    // Copy content from the old table into the new one.
    db.run({ query: `INSERT INTO ${tempTableName} SELECT * FROM ${tableName}` });

    // Drop the old table and rename the new one into its place.
    db.run({ query: `DROP TABLE ${tableName}` });
    db.run({ query: `ALTER TABLE ${tempTableName} RENAME TO ${tableName}` });

    // Recreate the indexes and triggers that belonged to the old table.
    for (const { type, sql: sqlStatement } of schema) {
      if (type === "table" || sqlStatement === null) {
        continue;
      }
      if (type !== "index" && type !== "trigger") {
        throw new Error(`Unsupported schema type: ${type}`);
      }
      db.run({ query: sqlStatement });
    }
  });
}

function modifyTableSql(
  tableName: string,
  tempTableName: string,
  tableSql: string,
  actions: AlterTableColumnAction[],
): string {
  const statement = splitTableCreation(tableSql);
  renameTable(statement, tableName, tempTableName);

  for (const action of actions) {
    const columnDefinition = statement.columnDefinitions.find((it) => {
      const nonWhitespaceIndex = it.findIndex((it) => it.trim().length > 0);
      return it[nonWhitespaceIndex] === action.column;
    });
    if (!columnDefinition) {
      throw new Error(`Column not found: ${action.column}`);
    }
    const columnNameIndex = columnDefinition.findIndex((it) => it.trim().length > 0);

    // Remove trailing comma to simplify the logic, we'll add it back later
    const endsWithComma = columnDefinition[columnDefinition.length - 1] === ",";
    if (endsWithComma) {
      columnDefinition.pop();
    }

    const actionName = action.action;
    switch (actionName) {
      case "addUnique": {
        columnDefinition.push(" ", "UNIQUE");
        break;
      }
      case "dropUnique": {
        const index = columnDefinition.findIndex((it) => it.toUpperCase() === "UNIQUE");
        if (index === -1) {
          throw new Error(`Column ${action.column} is not unique`);
        }
        columnDefinition.splice(index, 1);
        if (index > 0 && columnDefinition[index - 1]!.trim().length === 0) {
          columnDefinition.splice(index - 1, 1);
        }
        break;
      }
      case "changeType": {
        const fromTokens = splitTokens(action.from);
        const toTokens = splitTokens(action.to);
        if (fromTokens.length !== 1) {
          throw new Error(`Currently only supports single token types: ${action.from}`);
        }
        const typeIndex = columnNameIndex + 2; // separated by whitespace
        const existingType = columnDefinition[typeIndex];
        if (existingType !== action.from) {
          throw new Error(
            `Column ${action.column} is not of type ${action.from} (found ${existingType})`,
          );
        }
        columnDefinition.splice(typeIndex, 1, ...toTokens);
        break;
      }
      case "addNotNull": {
        columnDefinition.push(" ", "NOT", " ", "NULL");
        if (action.onConflict) {
          columnDefinition.push(" ", "ON", " ", "CONFLICT", " ", action.onConflict);
        }
        break;
      }
      case "dropNotNull": {
        const notNullSpan = findNotNullSpan(columnDefinition);
        if (!notNullSpan) {
          throw new Error(`Column ${action.column} has no NOT NULL constraint`);
        }
        removeSpanAndPrecedingWhitespace(columnDefinition, notNullSpan);
        break;
      }
      default:
        actionName satisfies never;
    }
    if (endsWithComma) {
      columnDefinition.push(",");
    }
  }

  return joinTableCreation(statement);
}

interface TableCreationTokens {
  pre: string[];
  columnDefinitions: string[][];
  post: string[];
}

function splitTokens(text: string): string[] {
  return text.split(/(\s+|,|[(]|[)])/g);
}

function splitTableCreation(statement: string): TableCreationTokens {
  const tokens = splitTokens(statement);
  const pre: string[] = [];
  const columnDefinitions: string[][] = [];
  const post: string[] = [];

  let state: "pre" | "columns" | "post" = "pre";
  let currentColumn: string[] | null = null;
  let columnsOpenParams = 0;
  for (const token of tokens) {
    switch (state) {
      case "pre":
        pre.push(token);
        if (token === "(") {
          state = "columns";
        }
        break;
      case "columns":
        if (token === ")" && columnsOpenParams === 0) {
          state = "post";
          post.push(token);
        } else if (token === "," && columnsOpenParams === 0) {
          if (currentColumn === null) {
            throw new Error("Unexpected comma");
          }
          currentColumn.push(token);
          currentColumn = null;
        } else {
          if (token === "(") {
            columnsOpenParams++;
          }
          if (token === ")") {
            columnsOpenParams--;
          }
          if (currentColumn === null) {
            currentColumn = [];
            columnDefinitions.push(currentColumn);
          }
          currentColumn.push(token);
        }
        break;
      case "post":
        if (token === ")") {
          throw new Error("Unexpected closing parenthesis");
        }
        post.push(token);
        break;
    }
  }

  return { pre, columnDefinitions, post };
}

function joinTableCreation({ pre, columnDefinitions, post }: TableCreationTokens) {
  return pre.join("") + columnDefinitions.map((it) => it.join("")).join("") + post.join("");
}

function renameTable(statement: TableCreationTokens, oldName: string, newName: string) {
  let state: "" | "create" | "table" | "if" | "not" | "exists" = "";
  for (let i = 0; i < statement.pre.length; i++) {
    const token = statement.pre[i]!;
    const isWhitespace = token.trim().length === 0;
    const tokenUpper = token.toUpperCase();
    switch (state) {
      case "":
        if (tokenUpper === "CREATE") {
          state = "create";
        } else if (!isWhitespace) {
          throw new Error(`Unexpected token: ${token}`);
        }
        break;
      case "create":
        if (tokenUpper === "TABLE") {
          state = "table";
        } else if (isWhitespace || tokenUpper === "TEMP" || tokenUpper === "TEMPORARY") {
          // ignore
        } else {
          throw new Error(`Unexpected token: ${token}`);
        }
        break;
      case "table":
        if (tokenUpper === "IF") {
          state = "if";
        } else if (!isWhitespace) {
          // found the table name
          if (token === oldName) {
            statement.pre[i] = newName;
            return;
          }
          if (token == `"${oldName}"`) {
            statement.pre[i] = `"${newName}"`;
            return;
          }
          throw new Error(`Unexpected table name: ${token} (expected ${oldName})`);
        }
        break;
      case "if":
        if (tokenUpper === "NOT") {
          state = "not";
        } else if (!isWhitespace) {
          throw new Error(`Unexpected token: ${token}`);
        }
        break;
      case "not":
        if (tokenUpper === "EXISTS") {
          state = "exists";
        } else if (!isWhitespace) {
          throw new Error(`Unexpected token: ${token}`);
        }
        break;
      case "exists":
        if (!isWhitespace) {
          // found the table name
          if (token === oldName) {
            statement.pre[i] = newName;
            return;
          }
          if (token == `"${oldName}"`) {
            statement.pre[i] = `"${newName}"`;
            return;
          }
          throw new Error(`Unexpected table name: ${token} (expected ${oldName})`);
        }
        break;
      default:
        state satisfies never;
    }
  }
}

function findNotNullSpan(tokens: string[]) {
  let notNullState: "" | "not" | "null" | "on" | "conflict" = "";
  let startIndex = -1;
  let nullIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const tokenUpper = token.toUpperCase();
    const isWhitespace = token.trim().length === 0;
    switch (notNullState) {
      case "":
        if (tokenUpper === "NOT") {
          notNullState = "not";
          startIndex = i;
        }
        break;
      case "not":
        if (tokenUpper === "NULL") {
          notNullState = "null";
          nullIndex = i;
        } else if (!isWhitespace) {
          notNullState = "";
          startIndex = -1;
        }
        break;
      case "null":
        if (tokenUpper === "ON") {
          notNullState = "on";
        } else if (!isWhitespace) {
          // found end of span
          return { startIndex, endIndex: nullIndex };
        }
        break;
      case "on":
        if (tokenUpper === "CONFLICT") {
          notNullState = "conflict";
        } else if (!isWhitespace) {
          throw new Error(`Unexpected token: ${token}`);
        }
        break;
      case "conflict":
        if (!isWhitespace) {
          // found end of span
          if (!["ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"].includes(tokenUpper)) {
            throw new Error(`Unexpected conflict resolution: ${token}`);
          }
          return { startIndex, endIndex: i };
        }
    }
  }
  if (notNullState === "null") {
    // not null at the end of the tokens
    return { startIndex, endIndex: tokens.length - 1 };
  }
  return null;
}

function removeSpanAndPrecedingWhitespace(
  tokens: string[],
  span: { startIndex: number; endIndex: number },
) {
  const { startIndex, endIndex } = span;
  tokens.splice(startIndex, endIndex - startIndex + 1);
  const precedingIndex = startIndex - 1;
  if (precedingIndex >= 0 && tokens[precedingIndex]!.trim().length === 0) {
    tokens.splice(precedingIndex, 1);
  }
}
