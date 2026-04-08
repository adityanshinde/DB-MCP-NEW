import * as z from 'zod/v4';

import { McpServer } from '../../mcp-sdk-runtime.mjs';
import { CONFIG } from '../config';
import { getConstraints } from '../tools/getConstraints';
import { compareSchema } from '../tools/compareSchema';
import { getForeignKeySummary } from '../tools/getForeignKeySummary';
import { getDatabaseInfo } from '../tools/getDatabaseInfo';
import { getColumnStats } from '../tools/getColumnStats';
import { compareObjectVersions } from '../tools/compareObjectVersions';
import { getDependencyGraph } from '../tools/getDependencyGraph';
import { getFunctionSummary } from '../tools/getFunctionSummary';
import { getIndexes } from '../tools/getIndexes';
import { getRelationPath } from '../tools/getRelationPath';
import { getProcedureSummary } from '../tools/getProcedureSummary';
import { getRelationships } from '../tools/getRelationships';
import { getSampleRows } from '../tools/getSampleRows';
import { explainQuery } from '../tools/explainQuery';
import { getTableSchema } from '../tools/getSchema';
import { getTableSampleByColumns } from '../tools/getTableSampleByColumns';
import { getTableSummary } from '../tools/getTableSummary';
import { executeReadQuery } from '../tools/executeReadQuery';
import { listOrgRepos } from '../tools/github/listOrgRepos';
import { getRepoTree } from '../tools/github/getRepoTree';
import { getFileContent } from '../tools/github/getFileContent';
import { searchCode } from '../tools/github/searchCode';
import { fileSummary } from '../tools/github/fileSummary';
import { moduleSummary } from '../tools/github/moduleSummary';
import { getViewSummary } from '../tools/getViewSummary';
import { listSchemas } from '../tools/listSchemas';
import { listStoredProcedures } from '../tools/listStoredProcedures';
import { listTables } from '../tools/listTables';
import { getRowCount } from '../tools/getRowCount';
import { searchTables } from '../tools/searchTables';
import { searchViews } from '../tools/searchViews';
import { searchFunctions } from '../tools/searchFunctions';
import { searchProcedures } from '../tools/searchProcedures';
import { searchColumns } from '../tools/searchColumns';
import { getViewDefinition } from '../tools/getViewDefinition';
import { runQuery } from '../tools/runQuery';
import { logMcpError } from '../runtime/observability';
import type { ToolResponse } from '../types';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const SUPPORTED_DATABASES = ['postgres', 'mssql', 'mysql', 'sqlite'] as const;

function toTextResult(result: ToolResponse<unknown>): CallToolResult {
  if (!result.success) {
    logMcpError('tool.execute.failed', new Error(result.error ?? 'Tool execution failed.'));
  }

  if (result.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data as Record<string, unknown>
    };
  }

  return {
    content: [{ type: 'text', text: result.error ?? 'Tool execution failed.' }],
    isError: true
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'db-mcp',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        logging: {}
      }
    }
  );

  server.registerTool(
    'list_schemas',
    {
      title: 'List Schemas',
      description: 'List available schemas or databases for the configured connection.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES)
      })
    },
    async ({ db }) => toTextResult(await listSchemas(db))
  );

  server.registerTool(
    'github.list_org_repos',
    {
      title: 'GitHub List Org Repos',
      description: 'List allowlisted repositories within a configured GitHub organization, using bounded pagination.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        page: z.number().int().min(1).max(100).default(1),
        per_page: z.number().int().min(1).max(100).default(30),
        filter: z.enum(['all', 'public', 'private', 'forks', 'sources', 'member']).default('all'),
        sort: z.enum(['created', 'updated', 'pushed', 'full_name']).default('created'),
        direction: z.enum(['asc', 'desc']).default('desc')
      })
    },
    async ({ org, page, per_page, filter, sort, direction }) => toTextResult(await listOrgRepos({ org, page, per_page, filter, sort, direction }))
  );

  server.registerTool(
    'github.get_repo_tree',
    {
      title: 'GitHub Get Repo Tree',
      description: 'Explore an allowlisted GitHub repository tree with a bounded depth and result cap.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().optional(),
        branch: z.string().optional(),
        depth: z.number().int().min(1).max(CONFIG.github.treeMaxDepth).default(CONFIG.github.treeMaxDepth)
      })
    },
    async ({ org, repo, path, branch, depth }) => toTextResult(await getRepoTree(repo, path, branch, depth, org))
  );

  server.registerTool(
    'github.get_file_content',
    {
      title: 'GitHub Get File Content',
      description: 'Fetch the contents of a single allowlisted repository file.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().min(1),
        branch: z.string().optional()
      })
    },
    async ({ org, repo, path, branch }) => toTextResult(await getFileContent(repo, path, branch, org))
  );

  server.registerTool(
    'github.search_code',
    {
      title: 'GitHub Search Code',
      description: 'Search within an allowlisted GitHub repository using read-only code search.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().optional(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(10),
        language: z.string().optional()
      })
    },
    async ({ org, repo, query, limit, language }) => toTextResult(await searchCode(repo, query, limit, language, org))
  );

  server.registerTool(
    'github.file_summary',
    {
      title: 'GitHub File Summary',
      description: 'Return a compact bounded summary for a single file in an allowlisted repository.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().min(1),
        branch: z.string().optional(),
        context_lines: z.number().int().min(1).max(10).default(CONFIG.github.summaryContextLines),
        focus_pattern: z.string().optional()
      })
    },
    async ({ org, repo, path, branch, context_lines, focus_pattern }) =>
      toTextResult(await fileSummary({ org, repo, path, branch, context_lines, focus_pattern }))
  );

  server.registerTool(
    'github.module_summary',
    {
      title: 'GitHub Module Summary',
      description: 'Return a compact bounded summary for a repository folder.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().optional(),
        path: z.string().min(1),
        branch: z.string().optional(),
        max_files: z.number().int().min(5).max(50).default(20),
        extensions: z.array(z.string().min(1)).optional()
      })
    },
    async ({ org, repo, path, branch, max_files, extensions }) =>
      toTextResult(await moduleSummary({ org, repo, path, branch, max_files, extensions }))
  );

  server.registerTool(
    'get_database_info',
    {
      title: 'Get Database Info',
      description: 'Read the current database name, version, and session context.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES)
      })
    },
    async ({ db }) => toTextResult(await getDatabaseInfo(db))
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run Query',
      description: 'Run a safe read-only SQL query against a configured database.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1)
      })
    },
    async ({ db, query }) => toTextResult(await runQuery(db, query))
  );

  server.registerTool(
    'db.execute_read_query',
    {
      title: 'Execute Read Query',
      description: 'Execute a strictly validated SELECT-only query with a hard result cap.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1)
      })
    },
    async ({ db, query }) => toTextResult(await executeReadQuery(db, query))
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'List tables from the configured database.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES)
      })
    },
    async ({ db }) => toTextResult(await listTables(db))
  );

  server.registerTool(
    'search_tables',
    {
      title: 'Search Tables',
      description: 'Search for tables by partial name.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, query, schema }) => toTextResult(await searchTables(db, query, schema))
  );

  server.registerTool(
    'search_views',
    {
      title: 'Search Views',
      description: 'Search for views by partial name with a small capped result set.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, query, schema, limit }) => toTextResult(await searchViews(db, query, schema, limit))
  );

  server.registerTool(
    'search_functions',
    {
      title: 'Search Functions',
      description: 'Search for functions by partial name with a small capped result set.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, query, schema, limit }) => toTextResult(await searchFunctions(db, query, schema, limit))
  );

  server.registerTool(
    'search_procedures',
    {
      title: 'Search Procedures',
      description: 'Search for stored procedures by partial name with a small capped result set.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, query, schema, limit }) => toTextResult(await searchProcedures(db, query, schema, limit))
  );

  server.registerTool(
    'search_columns',
    {
      title: 'Search Columns',
      description: 'Search for columns by partial name with a small capped result set.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, query, schema, limit }) => toTextResult(await searchColumns(db, query, schema, limit))
  );

  server.registerTool(
    'get_table_schema',
    {
      title: 'Get Table Schema',
      description: 'Inspect the schema for a single table.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getTableSchema(db, table, schema))
  );

  server.registerTool(
    'get_table_summary',
    {
      title: 'Get Table Summary',
      description: 'Return a compact table summary with only preview columns and key metadata.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getTableSummary(db, table, schema))
  );

  server.registerTool(
    'get_view_definition',
    {
      title: 'Get View Definition',
      description: 'Inspect the SQL definition for a view.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        view: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, view, schema }) => toTextResult(await getViewDefinition(db, view, schema))
  );

  server.registerTool(
    'get_view_summary',
    {
      title: 'Get View Summary',
      description: 'Return a compact view summary with preview columns and a truncated definition.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        view: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, view, schema }) => toTextResult(await getViewSummary(db, view, schema))
  );

  server.registerTool(
    'get_procedure_summary',
    {
      title: 'Get Procedure Summary',
      description: 'Return a compact stored procedure summary with a short signature and parameters.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        procedure: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, procedure, schema }) => toTextResult(await getProcedureSummary(db, procedure, schema))
  );

  server.registerTool(
    'get_function_summary',
    {
      title: 'Get Function Summary',
      description: 'Return a compact function summary with a short signature and parameters.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        func: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, func, schema }) => toTextResult(await getFunctionSummary(db, func, schema))
  );

  server.registerTool(
    'get_sample_rows',
    {
      title: 'Get Sample Rows',
      description: 'Return a small capped sample of rows for a table.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(5).default(5)
      })
    },
    async ({ db, table, schema, limit }) => toTextResult(await getSampleRows(db, table, schema, limit))
  );

  server.registerTool(
    'get_table_sample_by_columns',
    {
      title: 'Get Table Sample By Columns',
      description: 'Return a tiny sample of selected columns only, to save tokens.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional(),
        columns: z.array(z.string().min(1)).optional(),
        limit: z.number().int().min(1).max(5).default(5)
      })
    },
    async ({ db, table, schema, columns, limit }) =>
      toTextResult(await getTableSampleByColumns(db, table, schema, columns, limit))
  );

  server.registerTool(
    'get_row_count',
    {
      title: 'Get Row Count',
      description: 'Return the exact row count for a table without returning any rows.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getRowCount(db, table, schema))
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain Query',
      description: 'Return a compact execution plan for a read-only query.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        query: z.string().min(1)
      })
    },
    async ({ db, query }) => toTextResult(await explainQuery(db, query))
  );

  server.registerTool(
    'compare_schema',
    {
      title: 'Compare Schema',
      description: 'Compare two table schemas and return only the structural differences.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        left_table: z.string().min(1),
        right_table: z.string().min(1),
        left_schema: z.string().optional(),
        right_schema: z.string().optional()
      })
    },
    async ({ db, left_table, right_table, left_schema, right_schema }) =>
      toTextResult(await compareSchema(db, left_table, right_table, left_schema, right_schema))
  );

  server.registerTool(
    'compare_object_versions',
    {
      title: 'Compare Object Versions',
      description: 'Compare two tables, views, procedures, or functions and return only the compact differences.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        object_type: z.enum(['table', 'view', 'procedure', 'function']),
        left_name: z.string().min(1),
        right_name: z.string().min(1),
        schema: z.string().optional(),
        left_schema: z.string().optional(),
        right_schema: z.string().optional()
      })
    },
    async ({ db, object_type, left_name, right_name, schema, left_schema, right_schema }) =>
      toTextResult(await compareObjectVersions(db, object_type, left_name, right_name, schema, left_schema, right_schema))
  );

  server.registerTool(
    'get_dependency_graph',
    {
      title: 'Get Dependency Graph',
      description: 'Return a compact foreign-key dependency graph with nodes and edges only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().optional(),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, table, schema, limit }) => toTextResult(await getDependencyGraph(db, table, schema, limit))
  );

  server.registerTool(
    'get_column_stats',
    {
      title: 'Get Column Stats',
      description: 'Return compact row and cardinality stats for a few table columns.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(5).default(5)
      })
    },
    async ({ db, table, schema, limit }) => toTextResult(await getColumnStats(db, table, schema, limit))
  );

  server.registerTool(
    'get_relationships',
    {
      title: 'Get Relationships',
      description: 'Inspect foreign-key relationships for a database schema or table.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().optional(),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getRelationships(db, table, schema))
  );

  server.registerTool(
    'get_relation_path',
    {
      title: 'Get Relation Path',
      description: 'Find a compact foreign-key path between two tables using existing relationship data.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        source_table: z.string().min(1),
        target_table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10)
      })
    },
    async ({ db, source_table, target_table, schema, limit }) =>
      toTextResult(await getRelationPath(db, source_table, target_table, schema, limit))
  );

  server.registerTool(
    'get_indexes',
    {
      title: 'Get Indexes',
      description: 'Inspect table indexes and index columns.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().optional(),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getIndexes(db, table, schema))
  );

  server.registerTool(
    'get_constraints',
    {
      title: 'Get Constraints',
      description: 'Inspect primary keys, unique constraints, foreign keys, and checks.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES),
        table: z.string().optional(),
        schema: z.string().optional()
      })
    },
    async ({ db, table, schema }) => toTextResult(await getConstraints(db, table, schema))
  );

  server.registerTool(
    'list_stored_procedures',
    {
      title: 'List Stored Procedures',
      description: 'List stored procedures from the configured database.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        db: z.enum(SUPPORTED_DATABASES)
      })
    },
    async ({ db }) => toTextResult(await listStoredProcedures(db))
  );

  return server;
}