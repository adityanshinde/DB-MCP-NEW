# MCP Database Server

This project is a remote MCP server for safe, read-only database access.
It is built with Next.js App Router, TypeScript, and a Node.js runtime so it can run on Vercel.

## What this project does

The server exposes a Claude-compatible remote MCP endpoint at `/api/mcp`.
The MCP transport is stateless so it works correctly on Vercel-style serverless deployments without in-memory session affinity.
Claude or any MCP client can use it to:

- list tables
- inspect table schemas
- inspect foreign-key relationships
- list stored procedures
- run safe read-only SQL queries

The backend never connects to databases in write mode and rejects unsafe SQL before execution.

## Tech stack

- Next.js App Router
- TypeScript
- Node.js runtime
- MCP server SDK
- PostgreSQL driver: `pg`
- MSSQL driver: `mssql`
- No ORM

## Project structure

- `app/api/mcp/route.ts` - MCP HTTP handler
- `lib/config.ts` - central configuration and env access
- `lib/db/postgres.ts` - PostgreSQL connection pool and query helper
- `lib/db/mssql.ts` - MSSQL connection pool and query helper
- `lib/tools/runQuery.ts` - safe query execution tool
- `lib/tools/listTables.ts` - list tables tool
- `lib/tools/getSchema.ts` - table schema tool
- `lib/tools/getRelationships.ts` - FK relationship discovery tool
- `lib/tools/listStoredProcedures.ts` - stored procedure listing tool
- `lib/validators/queryValidator.ts` - read-only SQL validation
- `lib/types.ts` - shared types for requests and responses

## Setup

1. Install dependencies:
   - `npm install`
2. Copy `.env.example` to `.env`
3. Paste your credentials into `.env`
4. Run locally:
   - `npm run dev`

## Environment variables

All runtime settings are controlled from one place only: `.env` and `lib/config.ts`.

```env
POSTGRES_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
MSSQL_CONNECTION_STRING=Data Source=13.235.202.125;Initial Catalog=REPORT_DB_FROMKG;User ID=sa;Password=your_password;Encrypt=false;TrustServerCertificate=true
GITHUB_PAT=replace_with_github_pat
GITHUB_ORG_NAME=myorg
GITHUB_ALLOWED_ORGS=myorg
GITHUB_ALLOWED_REPOS=owner1/repo1,owner2/repo2
GITHUB_MAX_FILE_SIZE_BYTES=300000
GITHUB_TREE_MAX_DEPTH=3
GITHUB_ORG_REPO_PAGE_SIZE=30
GITHUB_REPO_RESOLUTION_MAX_SCANS=3
GITHUB_SUMMARY_CONTEXT_LINES=3
GITHUB_SUMMARY_PREVIEW_BYTES=2000
UPSTASH_REDIS_REST_URL=https://your-upstash-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace_with_upstash_token
MCP_CACHE_L1=true
MCP_CACHE_L1_MAX_ENTRIES=256
MCP_UI_ORIGIN=https://your-allowed-ui.example.com
SQLITE_ALLOWED_DIR=C:\path\to\allowed\sqlite\dir
```

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to enable the shared L2 cache. `MCP_CACHE_L1=true` keeps the optional in-memory L1 cache on for warm instances.

Set `GITHUB_PAT`, `GITHUB_ORG_NAME`, and `GITHUB_ALLOWED_REPOS` to enable the read-only GitHub tools. The allowlist is required and only `owner/repo` pairs in that list can be accessed. `GITHUB_ALLOWED_ORGS` lets you restrict org-level listing. `GITHUB_MAX_FILE_SIZE_BYTES` keeps file fetches bounded, `GITHUB_TREE_MAX_DEPTH` limits repository tree traversal, `GITHUB_ORG_REPO_PAGE_SIZE` bounds org listing pages, and `GITHUB_SUMMARY_CONTEXT_LINES` / `GITHUB_SUMMARY_PREVIEW_BYTES` keep summaries compact.

## Centralized config behavior

The file `lib/config.ts` contains all application settings used by the server.
It defines:

- PostgreSQL connection string
- MSSQL connection string
- max row limit for query execution
- allowed schemas

Changing `.env` is enough to reconfigure the backend.

## Supported tools

### 1. `run_query`

Input:

```json
{
  "db": "postgres",
  "query": "SELECT * FROM users"
}
```

Behavior:

- validates the SQL
- blocks unsafe statements
- injects `LIMIT 50` for PostgreSQL when needed
- injects `TOP (50)` for MSSQL when needed
- executes the query through the correct pool
- returns rows and metadata

### 2. `list_tables`

Lists tables from the chosen database:

- PostgreSQL: `pg_catalog.pg_tables`
- MSSQL: `INFORMATION_SCHEMA.TABLES`

### 3. `get_table_schema`

Returns column metadata for a selected table.

### 4. `get_relationships`

Returns foreign-key relationships using system catalogs.

### 5. `list_stored_procedures`

Lists stored procedures where the connected database supports them.

## Connect Claude

Use the deployed HTTPS endpoint as a remote MCP server URL in Claude.

1. Open Claude's connector setup.
2. Choose the custom connector option.
3. Paste your deployed endpoint URL, for example:

```text
https://your-vercel-domain.vercel.app/api/mcp
```

4. Save the connector and authenticate if your deployment requires it.

Set `MCP_UI_ORIGIN` to the exact UI origin you want to allow; wildcard origins are not used.

If you are testing locally, use your dev server URL instead:

```text
http://localhost:3000/api/mcp
```

## MCP tools

Claude will see these tools through the MCP protocol:

- `list_schemas`
- `get_database_info`
- `run_query`
- `list_tables`
- `search_tables`
- `search_columns`
- `get_table_schema`
- `get_table_summary`
- `get_view_definition`
- `get_view_summary`
- `get_procedure_summary`
- `get_function_summary`
- `get_sample_rows`
- `explain_query`
- `compare_schema`
- `get_column_stats`
- `search_views`
- `get_row_count`
- `get_foreign_key_summary`
- `search_functions`
- `search_procedures`
- `get_table_sample_by_columns`
- `get_dependency_graph`
- `get_relation_path`
- `compare_object_versions`
- `get_relationships`
- `get_indexes`
- `get_constraints`
- `list_stored_procedures`
- `github.get_commit_history`
- `github.get_file_history`
- `github.compare_refs`
- `github.get_pull_request_comments`

The endpoint also keeps the previous custom JSON body format for backwards compatibility.

True line-by-line blame is still not available from the current serverless deployment model. For that, you would need either a self-hosted server with a checked-out git repository or a GitHub GraphQL-based implementation that exposes blame data.

## Legacy API contract

Send a POST request to `/api/mcp` with this shape:

```json
{
  "tool": "run_query",
  "input": {}
}
```

Example tool requests:

### list_tables

```json
{
  "tool": "list_tables",
  "input": {
    "db": "postgres"
  }
}
```

### run_query

```json
{
  "tool": "run_query",
  "input": {
    "db": "postgres",
    "query": "SELECT * FROM users"
  }
}
```

### get_table_schema

```json
{
  "tool": "get_table_schema",
  "input": {
    "db": "mssql",
    "table": "Users",
    "schema": "dbo"
  }
}
```

### get_relationships

```json
{
  "tool": "get_relationships",
  "input": {
    "db": "postgres",
    "schema": "public"
  }
}
```

### list_stored_procedures

```json
{
  "tool": "list_stored_procedures",
  "input": {
    "db": "postgres"
  }
}
```

## Response format

Every tool returns the same envelope:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

On failure:

```json
{
  "success": false,
  "data": null,
  "error": "Reason message"
}
```

## Security rules

- read-only queries only
- allow only `SELECT`, `WITH`, and `EXPLAIN`
- reject `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `MERGE`, and similar write operations
- reject multiple statements
- reject SQL comments
- reject dangerous keywords such as `exec`, `grant`, and `xp_`
- use read-only database users only
- limit access to allowed schemas only

## Performance notes

- PostgreSQL uses a persistent `pg.Pool`
- MSSQL uses a cached `ConnectionPool`
- connections are reused across requests
- imports are kept lightweight

## Deployment

This backend is ready for Vercel deployment.

### Node runtime

The API route is forced to use the Node.js runtime.

### Vercel note

If needed, the deployment uses `vercel.json` to pin the function runtime.

## Test requests

### Load tables

Use the `list_tables` payload for either database.

### Safe query

```json
{
  "tool": "run_query",
  "input": {
    "db": "postgres",
    "query": "SELECT * FROM users LIMIT 5"
  }
}
```

### Schema lookup

```json
{
  "tool": "get_table_schema",
  "input": {
    "db": "postgres",
    "table": "users",
    "schema": "public"
  }
}
```

## Troubleshooting

- Make sure the Claude connector URL is the deployed HTTPS endpoint, not the repo URL
- If the server says a DB is not configured, check `.env`
- If queries are rejected, verify that they start with `SELECT`, `WITH`, or `EXPLAIN`
- If schemas are rejected, confirm the schema is in the allowed list
- If Vercel deployment fails, ensure the function is running on Node.js, not Edge

## Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run start`

