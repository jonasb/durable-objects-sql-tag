---
"durable-objects-sql-tag": minor
---

Add `alterTableColumns` for migrating column constraints. It rebuilds a table to add/drop `NOT NULL` and `UNIQUE` constraints or change a column's type, preserving data, indexes, and triggers. Intended for use inside a migration's `migrate(db)` function.
