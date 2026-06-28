---
"durable-objects-sql-tag": minor
---

The library no longer logs migration progress itself. Use the new `onMigrate` option on `db.migrate(migrations, { ... })` to log each migration as it runs:

```ts
db.migrate(migrations, {
  onMigrate: ({ targetVersion, definition }) =>
    console.log(`Migrating database to version ${targetVersion}: ${definition.name}...`),
});
```
