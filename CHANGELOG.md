# durable-objects-sql-tag

## 0.4.0

### Minor Changes

- df4cf74: The library no longer logs migration progress itself. Use the new `onMigrate` option on `db.migrate(migrations, { ... })` to log each migration as it runs:

  ```ts
  db.migrate(migrations, {
    onMigrate: ({ targetVersion, definition }) =>
      console.log(`Migrating database to version ${targetVersion}: ${definition.name}...`),
  });
  ```

## 0.3.0

### Minor Changes

- 8b3553b: Migrations are now async, and `alterTableColumns` is safe to use on foreign-key parent tables.

  **Breaking:** `wrapDatabase` no longer runs migrations. Call the new async `db.migrate(migrations)` instead — typically inside `ctx.blockConcurrencyWhile` so requests wait for it:

  ```ts
  // Before
  this.db = wrapDatabase(ctx.storage, { migrations });

  // After
  this.db = wrapDatabase(ctx.storage);
  ctx.blockConcurrencyWhile(() => this.db.migrate(migrations));
  ```

  Migrations are async because disabling foreign key enforcement (required to safely rebuild a table) is only possible once the implicit transaction is committed via `storage.sync()`.
  - New `disableForeignKeys?: boolean` option on a migration. When set, the runner commits, disables foreign keys for the migration, then restores them — needed to rebuild a table that another table references via a foreign key. It verifies enforcement was actually restored, and runs `PRAGMA foreign_key_check` afterward so a migration that leaves a dangling reference throws (without being recorded) rather than silently committing corrupt data.
  - `alterTableColumns` now throws when foreign keys are enabled and another table references the one being rebuilt, instead of silently deleting child rows (for `ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT`) or failing the foreign key check at commit (for plain references). Run it from a `disableForeignKeys: true` migration to alter these tables. Tables with no incoming references — and self-references — are unaffected.

## 0.2.0

### Minor Changes

- 0556975: Add `alterTableColumns` for migrating column constraints. It rebuilds a table to add/drop `NOT NULL` and `UNIQUE` constraints or change a column's type, preserving data, indexes, and triggers. Intended for use inside a migration's `migrate(db)` function.

## 0.1.1

### Patch Changes

- dc9a2fe: Bump dependencies (first deploy through github actions)
