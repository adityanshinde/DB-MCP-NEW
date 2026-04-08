# DB-MCP Database & Query-Safety Log

This log was produced from a dedicated database-safety subagent review.

## Configuration

- [lib/config.ts](../lib/config.ts) centralizes database URLs, query limits, schema allowlists, and GitHub-related runtime limits.
- Global query timeout is 15 seconds.
- Maximum query result rows are capped at 50.
- Allowed schemas are hardcoded to `public` and `dbo`.

## Type System

- [lib/types.ts](../lib/types.ts) defines `DBType`, tool input mappings, `DatabaseCredentials`, and the shared `ToolResponse<T>` envelope.
- Tool results consistently use `success`, `data`, and `error` fields.

## Query Validation

- [lib/validators/queryValidator.ts](../lib/validators/queryValidator.ts) blocks unsafe SQL.
- Semicolons are rejected to prevent multiple statements.
- SQL comments are rejected.
- Dangerous keywords such as `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `EXEC`, and related variants are blocked.
- Allowed statement families are `SELECT`, `WITH`, and `EXPLAIN` for read-only mode.
- `validateSelectOnlyQuery()` is stricter and allows only `SELECT`.

## Read-Only Execution

- [lib/tools/database/runQuery.ts](../lib/tools/database/runQuery.ts) validates read-only SQL and injects database-specific row limits.
- [lib/tools/database/executeReadQuery.ts](../lib/tools/database/executeReadQuery.ts) enforces SELECT-only execution and caps results.
- PostgreSQL and MySQL/SQLite use wrapper-based limits.
- MSSQL uses `TOP (...)` injection.

## Adapters

- [lib/db/postgres.ts](../lib/db/postgres.ts) uses static and dynamic pools with URL-encoded credentials.
- [lib/db/mssql.ts](../lib/db/mssql.ts) uses connection pools with encryption enabled and `trustServerCertificate: false`.
- [lib/db/mysql.ts](../lib/db/mysql.ts) uses `mysql2/promise` pools with per-query timeout.
- [lib/db/sqlite.ts](../lib/db/sqlite.ts) validates file paths, supports `:memory:`, and enforces an allowed directory.

## Identifier Quoting and Schema Handling

- [lib/tools/database/toolUtils.ts](../lib/tools/database/toolUtils.ts) contains the shared identifier quoting helper.
- PostgreSQL and SQLite use double quotes.
- MySQL uses backticks.
- MSSQL uses bracket quoting.
- Schema resolution is enforced in tool code for PostgreSQL and MSSQL through the allowed-schema list.

## Safety Notes

- Parameterized queries are used instead of string interpolation for values.
- SQLite paths are checked to prevent traversal outside the allowed directory.
- Some adapters differ in how strongly schema restrictions are enforced, so behavior is not perfectly uniform across all databases.
- Legacy tool requests can supply credentials, but the MCP tool schemas themselves remain server-side and read-only.

## Practical Risks

- Hardcoded schema allowlists are strict and may require code changes for new schema names.
- Result-limit injection behavior differs slightly by database.
- SQLite uses client-side timeout interruption rather than a server-side timeout primitive.
