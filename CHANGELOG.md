# durable-objects-sql-tag

## 0.2.0

### Minor Changes

- 0556975: Add `alterTableColumns` for migrating column constraints. It rebuilds a table to add/drop `NOT NULL` and `UNIQUE` constraints or change a column's type, preserving data, indexes, and triggers. Intended for use inside a migration's `migrate(db)` function.

## 0.1.1

### Patch Changes

- dc9a2fe: Bump dependencies (first deploy through github actions)
