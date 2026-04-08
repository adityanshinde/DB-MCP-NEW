import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { CONFIG } from '@/lib/config';

import { getConstraints } from '@/lib/tools/getConstraints';
import { compareSchema } from '@/lib/tools/compareSchema';
import { getForeignKeySummary } from '@/lib/tools/getForeignKeySummary';
import { getDatabaseInfo } from '@/lib/tools/getDatabaseInfo';
import { getColumnStats } from '@/lib/tools/getColumnStats';
import { compareObjectVersions } from '@/lib/tools/compareObjectVersions';
import { getDependencyGraph } from '@/lib/tools/getDependencyGraph';
import { getFunctionSummary } from '@/lib/tools/getFunctionSummary';
import { getIndexes } from '@/lib/tools/getIndexes';
import { getRelationPath } from '@/lib/tools/getRelationPath';
import { getProcedureSummary } from '@/lib/tools/getProcedureSummary';
import { getRelationships } from '@/lib/tools/getRelationships';
import { getSampleRows } from '@/lib/tools/getSampleRows';
import { explainQuery } from '@/lib/tools/explainQuery';
import { getTableSchema } from '@/lib/tools/getSchema';
import { getTableSampleByColumns } from '@/lib/tools/getTableSampleByColumns';
import { getTableSummary } from '@/lib/tools/getTableSummary';
import { executeReadQuery } from '@/lib/tools/executeReadQuery';
import { listOrgRepos } from '@/lib/tools/github/listOrgRepos';
import { getRepoTree } from '@/lib/tools/github/getRepoTree';
import { getFileContent } from '@/lib/tools/github/getFileContent';
import { searchCode } from '@/lib/tools/github/searchCode';
import { fileSummary } from '@/lib/tools/github/fileSummary';
import { moduleSummary } from '@/lib/tools/github/moduleSummary';
import { getCommitHistory } from '@/lib/tools/github/getCommitHistory';
import { getFileHistory } from '@/lib/tools/github/getFileHistory';
import { compareRefs } from '@/lib/tools/github/compareRefs';
import { getPullRequestComments } from '@/lib/tools/github/getPullRequestComments';
import { getGitHubMetrics } from '@/lib/tools/github/githubClient';
import { getViewSummary } from '@/lib/tools/getViewSummary';
import { listSchemas } from '@/lib/tools/listSchemas';
import { listStoredProcedures } from '@/lib/tools/listStoredProcedures';
import { listTables } from '@/lib/tools/listTables';
import { getRowCount } from '@/lib/tools/getRowCount';
import { searchTables } from '@/lib/tools/searchTables';
import { searchViews } from '@/lib/tools/searchViews';
import { searchFunctions } from '@/lib/tools/searchFunctions';
import { searchProcedures } from '@/lib/tools/searchProcedures';
import { searchColumns } from '@/lib/tools/searchColumns';
import { getViewDefinition } from '@/lib/tools/getViewDefinition';
import { runQuery } from '@/lib/tools/runQuery';
import { getMetadataCacheMetrics } from '@/lib/cache/metadataCache';
import { installProcessGuards } from '@/lib/runtime/processGuards';
import { MCP_METRICS } from '@/lib/runtime/mcpMetrics';
import { logMcpEvent, logMcpError } from '@/lib/runtime/observability';
import type { ToolRequestWithCredentials, ToolResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ORIGIN = process.env.MCP_UI_ORIGIN?.trim() || '';
const ALLOWED_METHODS = 'POST, GET, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, MCP-Protocol-Version, Mcp-Session-Id';
const SUPPORTED_DATABASES = ['postgres', 'mssql', 'mysql', 'sqlite'] as const;

installProcessGuards();

let isColdStart = true;

type SessionEntry = {
  sessionId: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  ready: Promise<void>;
  queue: Promise<void>;
  createdAt: number;
  lastUsedAt: number;
};

type SessionResolution = {
  sessionId: string;
  entry: SessionEntry;
  created: boolean;
  reused: boolean;
};

const sessionEntries = new Map<string, SessionEntry>();

function logRequestEvent(event: string, request: Request, extra: Record<string, unknown> = {}): void {
  logMcpEvent(event, {
    method: request.method,
    path: new URL(request.url).pathname,
    sessionId: readSessionId(request),
    totalRequests: MCP_METRICS.request.totalRequests,
    ...extra
  });
}

function readSessionId(request: Request): string | null {
  return request.headers.get('Mcp-Session-Id')?.trim() || null;
}

function readMcpMethod(rawBody?: string): string | null {
  if (!rawBody) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawBody) as { jsonrpc?: string; method?: string } | null;
    if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0' && typeof parsed.method === 'string') {
      return parsed.method;
    }
  } catch {
    return null;
  }

  return null;
}

function isInitializationPayload(rawBody?: string): boolean {
  return readMcpMethod(rawBody) === 'initialize';
}

async function createSessionEntry(sessionId: string): Promise<SessionEntry> {
  MCP_METRICS.session.sessionsCreated += 1;
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: false
  });

  MCP_METRICS.session.transportsCreated += 1;

  const entry: SessionEntry = {
    sessionId,
    server,
    transport,
    ready: Promise.resolve(),
    queue: Promise.resolve(),
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  };

  sessionEntries.set(sessionId, entry);

  try {
    entry.ready = server.connect(transport);
    await entry.ready;
    return entry;
  } catch (error) {
    logMcpError('session.create_failed', error, { sessionId });
    await closeSessionEntry(sessionId);
    throw error;
  }
}

async function getSessionEntry(sessionId: string, allowCreate: boolean): Promise<{ entry: SessionEntry | null; created: boolean; reused: boolean }> {
  const existing = sessionEntries.get(sessionId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    MCP_METRICS.session.sessionsReused += 1;
    return {
      entry: existing,
      created: false,
      reused: true
    };
  }

  if (!allowCreate) {
    return {
      entry: null,
      created: false,
      reused: false
    };
  }

  return {
    entry: await createSessionEntry(sessionId),
    created: true,
    reused: false
  };
}

async function resolveSessionEntry(request: Request, rawBody?: string): Promise<SessionResolution | Response> {
  const sessionId = readSessionId(request);
  const initializing = isInitializationPayload(rawBody);

  if (sessionId) {
    const existing = sessionEntries.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      MCP_METRICS.session.sessionsReused += 1;
      return {
        sessionId,
        entry: existing,
        created: false,
        reused: true
      };
    }

    if (!initializing) {
      MCP_METRICS.request.validationFailures += 1;
      logMcpEvent('request.validation_failed', {
        sessionId,
        requestType: 'jsonrpc',
        message: 'Unknown MCP session.',
        validationFailures: MCP_METRICS.request.validationFailures
      }, 'warn');
      return jsonError('Unknown MCP session.', 404);
    }

    return {
      sessionId,
      entry: await createSessionEntry(sessionId),
      created: true,
      reused: false
    };
  }

  if (!initializing) {
    MCP_METRICS.request.validationFailures += 1;
    logMcpEvent('request.validation_failed', {
      requestType: 'jsonrpc',
      message: 'MCP session id is required.',
      validationFailures: MCP_METRICS.request.validationFailures
    }, 'warn');
    return jsonError('MCP session id is required.', 400);
  }

  const generatedSessionId = randomUUID();
  return {
    sessionId: generatedSessionId,
    entry: await createSessionEntry(generatedSessionId),
    created: true,
    reused: false
  };
}

async function handleSessionTransportRequest(entry: SessionEntry, request: Request): Promise<Response> {
  const responsePromise = entry.queue.then(() => entry.transport.handleRequest(request));
  entry.queue = responsePromise.then(() => undefined, () => undefined);
  return responsePromise;
}

async function closeSessionEntry(sessionId: string): Promise<boolean> {
  const entry = sessionEntries.get(sessionId);
  if (!entry) {
    return false;
  }

  sessionEntries.delete(sessionId);

  const transport = entry.transport as unknown as {
    close?: () => void | Promise<void>;
    destroy?: () => void | Promise<void>;
    abort?: () => void | Promise<void>;
    dispose?: () => void | Promise<void>;
  };
  const server = entry.server as unknown as {
    close?: () => void | Promise<void>;
    dispose?: () => void | Promise<void>;
  };

  const cleanupErrors: unknown[] = [];

  for (const method of [transport.close, transport.dispose, transport.abort, transport.destroy]) {
    if (typeof method === 'function') {
      try {
        await method.call(transport);
        break;
      } catch (error) {
        logMcpError('session.transport_cleanup_failed', error, { sessionId });
        cleanupErrors.push(error);
      }
    }
  }

  for (const method of [server.close, server.dispose]) {
    if (typeof method === 'function') {
      try {
        await method.call(server);
        break;
      } catch (error) {
        logMcpError('session.server_cleanup_failed', error, { sessionId });
        cleanupErrors.push(error);
      }
    }
  }

  if (cleanupErrors.length > 0) {
    logMcpError('session.cleanup_completed_with_errors', cleanupErrors[0], { sessionId });
  }

  return true;
}

function withSessionHeaders(response: Response, sessionId: string, created: boolean, reused: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('Mcp-Session-Id', sessionId);
  headers.set('X-MCP-Session-Created', String(created));
  headers.set('X-MCP-Session-Reused', String(reused));
  headers.set('X-MCP-Transport-Created', String(MCP_METRICS.session.transportsCreated));
  headers.set('X-MCP-SSE-Failures', String(MCP_METRICS.session.sseFailures));
  headers.set('X-MCP-409-Errors', String(MCP_METRICS.session.conflict409s));
  headers.set('X-MCP-Delete-Requests', String(MCP_METRICS.session.deleteRequests));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  if (ALLOWED_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function withCacheHeaders(response: Response, coldStart: boolean): Response {
  const metrics = getMetadataCacheMetrics();
  const githubMetrics = getGitHubMetrics();
  const headers = new Headers(response.headers);
  headers.set('X-MCP-Cold-Start', String(coldStart));
  headers.set('X-MCP-Cache-L1-Hits', String(metrics.l1Hits));
  headers.set('X-MCP-Cache-L1-Misses', String(metrics.l1Misses));
  headers.set('X-MCP-Cache-L2-Hits', String(metrics.l2Hits));
  headers.set('X-MCP-Cache-L2-Misses', String(metrics.l2Misses));
  headers.set('X-MCP-Cache-DB-Fetches', String(metrics.dbFetches));
  headers.set('X-MCP-Cache-L1-Size', String(metrics.l1Size));
  headers.set('X-MCP-Cache-Payload-Too-Large', String(metrics.payloadTooLarge));
  headers.set('X-MCP-GitHub-API-Calls', String(githubMetrics.apiCalls));
  headers.set('X-MCP-GitHub-API-Errors', String(githubMetrics.apiErrors));
  headers.set('X-MCP-GitHub-Rate-Limit-Hits', String(githubMetrics.rateLimitHits));
  headers.set('X-MCP-GitHub-Allowlist-Rejects', String(githubMetrics.allowlistRejects));
  headers.set('X-MCP-GitHub-Oversized-Files', String(githubMetrics.oversizedFiles));
  headers.set('X-MCP-GitHub-Payload-Bytes-Read', String(githubMetrics.payloadBytesRead));
  headers.set('X-MCP-GitHub-Summary-Cache-Hits', String(githubMetrics.summaryCacheHits));
  headers.set('X-MCP-GitHub-Summary-Cache-Misses', String(githubMetrics.summaryCacheMisses));
  headers.set('X-MCP-GitHub-Repo-Resolution-Attempts', String(githubMetrics.repoResolutionAttempts));
  headers.set('X-MCP-GitHub-Repo-Resolution-Successes', String(githubMetrics.repoResolutionSuccesses));
  headers.set('X-MCP-GitHub-Repo-Resolution-Ambiguous', String(githubMetrics.repoResolutionAmbiguous));
  headers.set('X-MCP-GitHub-Repo-Resolution-Not-Found', String(githubMetrics.repoResolutionNotFound));
  headers.set('X-MCP-GitHub-Excessive-Repo-Scan', String(githubMetrics.excessiveRepoScanAttempts));
  headers.set('X-MCP-GitHub-Org-Repo-List-Calls', String(githubMetrics.orgRepoListCalls));
  headers.set('X-MCP-GitHub-Org-Repo-Filtered-Out', String(githubMetrics.orgRepoListFilteredOut));

  const topOrgCalls = Object.entries(githubMetrics.apiCallsByOrg)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');
  const topRepoCalls = Object.entries(githubMetrics.apiCallsByRepo)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');

  if (topOrgCalls) {
    headers.set('X-MCP-GitHub-API-Calls-By-Org', topOrgCalls);
  }

  if (topRepoCalls) {
    headers.set('X-MCP-GitHub-API-Calls-By-Repo', topRepoCalls);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonError(message: string, status: number): Response {
  if (status >= 400 && status < 500) {
    MCP_METRICS.request.validationFailures += 1;
    logMcpEvent('request.validation_failed', {
      status,
      message,
      validationFailures: MCP_METRICS.request.validationFailures
    }, 'warn');
  } else if (status >= 500) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.error_response', new Error(message), {
      status,
      errors: MCP_METRICS.request.errors
    });
  } else {
    logMcpEvent('request.response', { status, message }, 'warn');
  }

  return new NextResponse(
    JSON.stringify({
      success: false,
      data: null,
      error: message
    } satisfies ToolResponse),
    {
      status,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
}

function isMcpJsonRpcBody(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as { jsonrpc?: string; method?: string } | null;
    return Boolean(parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0' && typeof parsed.method === 'string');
  } catch {
    return false;
  }
}

function toTextResult(result: ToolResponse<unknown>): CallToolResult {
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
    'github.get_commit_history',
    {
      title: 'GitHub Commit History',
      description: 'List recent commits for a repository, optionally filtered by branch, path, or author.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().min(1),
        branch: z.string().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        page: z.number().int().min(1).max(100).default(1),
        per_page: z.number().int().min(1).max(100).default(10)
      })
    },
    async ({ org, repo, branch, path, author, page, per_page }) =>
      toTextResult(await getCommitHistory(repo, branch, path, author, page, per_page, org))
  );

  server.registerTool(
    'github.get_file_history',
    {
      title: 'GitHub File History',
      description: 'List commit history for a single file to show who changed it over time.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().min(1),
        path: z.string().min(1),
        branch: z.string().optional(),
        page: z.number().int().min(1).max(100).default(1),
        per_page: z.number().int().min(1).max(100).default(10)
      })
    },
    async ({ org, repo, path, branch, page, per_page }) =>
      toTextResult(await getFileHistory(repo, path, branch, page, per_page, org))
  );

  server.registerTool(
    'github.compare_refs',
    {
      title: 'GitHub Compare Refs',
      description: 'Compare two branches, tags, or commits and return a compact diff summary.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().min(1),
        base: z.string().min(1),
        head: z.string().min(1),
        max_files: z.number().int().min(1).max(50).default(20)
      })
    },
    async ({ org, repo, base, head, max_files }) => toTextResult(await compareRefs(repo, base, head, max_files, undefined, org))
  );

  server.registerTool(
    'github.get_pull_request_comments',
    {
      title: 'GitHub Pull Request Comments',
      description: 'Return issue comments, review comments, and review submissions for a pull request.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      inputSchema: z.object({
        org: z.string().optional(),
        repo: z.string().min(1),
        pull_number: z.number().int().min(1)
      })
    },
    async ({ org, repo, pull_number }) => toTextResult(await getPullRequestComments(repo, pull_number, org))
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

async function handleMcpRequest(request: Request, rawBody?: string): Promise<Response> {
  MCP_METRICS.request.jsonRpcRequests += 1;
  logRequestEvent('request.incoming', request, {
    requestKind: 'jsonrpc',
    jsonRpcMethod: readMcpMethod(rawBody)
  });

  const coldStartForThisRequest = isColdStart;

  try {
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);

    isColdStart = false;
    return withCacheHeaders(withCors(response), coldStartForThisRequest);
  } catch (error) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.transport_failed', error, {
      errors: MCP_METRICS.request.errors
    });

    const fallbackResponse = withCacheHeaders(
      withCors(
        new NextResponse(
          JSON.stringify({
            success: false,
            data: null,
            error: error instanceof Error ? error.message : 'Unexpected transport error.'
          } satisfies ToolResponse),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      ),
      coldStartForThisRequest
    );
    isColdStart = false;
    return fallbackResponse;
  }
}

async function handleSessionClose(request: Request): Promise<Response> {
  logRequestEvent('request.incoming', request, { requestKind: 'delete' });
  return withCors(
    new NextResponse(null, {
      status: 204
    })
  );
}

async function handleLegacyRequest(request: Request): Promise<Response> {
  MCP_METRICS.request.legacyRequests += 1;
  logRequestEvent('request.incoming', request, { requestKind: 'legacy' });

  try {
    const body = (await request.json()) as Partial<ToolRequestWithCredentials>;

    if (!body.tool) {
      return withCors(jsonError('A tool name is required.', 400));
    }

    switch (body.tool) {
      case 'run_query': {
        const input = body.input as ToolRequestWithCredentials<'run_query'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('run_query requires db and query.', 400));
        }

        const result = await runQuery(input.db, input.query, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'db.execute_read_query': {
        const input = body.input as ToolRequestWithCredentials<'db.execute_read_query'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('db.execute_read_query requires db and query.', 400));
        }

        const result = await executeReadQuery(input.db, input.query, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'list_schemas': {
        const input = body.input as ToolRequestWithCredentials<'list_schemas'>['input'];
        if (!input?.db) {
          return withCors(jsonError('list_schemas requires db.', 400));
        }

        const result = await listSchemas(input.db, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.get_repo_tree': {
        const input = body.input as ToolRequestWithCredentials<'github.get_repo_tree'>['input'];
        if (!input?.repo && !input?.org) {
          return withCors(jsonError('github.get_repo_tree requires repo or org.', 400));
        }

        const result = await getRepoTree(input.repo, input.path, input.branch, input.depth, input.org);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.get_file_content': {
        const input = body.input as ToolRequestWithCredentials<'github.get_file_content'>['input'];
        if ((!input?.repo && !input?.org) || !input?.path) {
          return withCors(jsonError('github.get_file_content requires repo or org and path.', 400));
        }

        const result = await getFileContent(input.repo, input.path, input.branch, input.org);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.search_code': {
        const input = body.input as ToolRequestWithCredentials<'github.search_code'>['input'];
        if ((!input?.repo && !input?.org) || !input?.query) {
          return withCors(jsonError('github.search_code requires repo or org and query.', 400));
        }

        const result = await searchCode(input.repo, input.query, input.limit, input.language, input.org);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.list_org_repos': {
        const input = body.input as ToolRequestWithCredentials<'github.list_org_repos'>['input'];
        const result = await listOrgRepos({
          org: input?.org,
          page: input?.page,
          per_page: input?.per_page,
          filter: input?.filter,
          sort: input?.sort,
          direction: input?.direction
        });
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.file_summary': {
        const input = body.input as ToolRequestWithCredentials<'github.file_summary'>['input'];
        if (!input?.path || (!input?.repo && !input?.org)) {
          return withCors(jsonError('github.file_summary requires repo or org and path.', 400));
        }

        const result = await fileSummary(input);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'github.module_summary': {
        const input = body.input as ToolRequestWithCredentials<'github.module_summary'>['input'];
        if (!input?.path || (!input?.repo && !input?.org)) {
          return withCors(jsonError('github.module_summary requires repo or org and path.', 400));
        }

        const result = await moduleSummary(input);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_database_info': {
        const input = body.input as ToolRequestWithCredentials<'get_database_info'>['input'];
        if (!input?.db) {
          return withCors(jsonError('get_database_info requires db.', 400));
        }

        const result = await getDatabaseInfo(input.db, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'list_tables': {
        const input = body.input as ToolRequestWithCredentials<'list_tables'>['input'];
        if (!input?.db) {
          return withCors(jsonError('list_tables requires db.', 400));
        }

        const result = await listTables(input.db, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'search_columns': {
        const input = body.input as ToolRequestWithCredentials<'search_columns'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('search_columns requires db and query.', 400));
        }

        const result = await searchColumns(input.db, input.query, input.schema, input.limit, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'search_tables': {
        const input = body.input as ToolRequestWithCredentials<'search_tables'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('search_tables requires db and query.', 400));
        }

        const result = await searchTables(input.db, input.query, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'search_procedures': {
        const input = body.input as ToolRequestWithCredentials<'search_procedures'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('search_procedures requires db and query.', 400));
        }

        const result = await searchProcedures(input.db, input.query, input.schema, input.limit, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_table_schema': {
        const input = body.input as ToolRequestWithCredentials<'get_table_schema'>['input'];
        if (!input?.db || !input?.table) {
          return withCors(jsonError('get_table_schema requires db and table.', 400));
        }

        const result = await getTableSchema(input.db, input.table, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_table_summary': {
        const input = body.input as ToolRequestWithCredentials<'get_table_summary'>['input'];
        if (!input?.db || !input?.table) {
          return withCors(jsonError('get_table_summary requires db and table.', 400));
        }

        const result = await getTableSummary(input.db, input.table, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_view_definition': {
        const input = body.input as ToolRequestWithCredentials<'get_view_definition'>['input'];
        if (!input?.db || !input?.view) {
          return withCors(jsonError('get_view_definition requires db and view.', 400));
        }

        const result = await getViewDefinition(input.db, input.view, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_view_summary': {
        const input = body.input as ToolRequestWithCredentials<'get_view_summary'>['input'];
        if (!input?.db || !input?.view) {
          return withCors(jsonError('get_view_summary requires db and view.', 400));
        }

        const result = await getViewSummary(input.db, input.view, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_procedure_summary': {
        const input = body.input as ToolRequestWithCredentials<'get_procedure_summary'>['input'];
        if (!input?.db || !input?.procedure) {
          return withCors(jsonError('get_procedure_summary requires db and procedure.', 400));
        }

        const result = await getProcedureSummary(input.db, input.procedure, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_function_summary': {
        const input = body.input as ToolRequestWithCredentials<'get_function_summary'>['input'];
        if (!input?.db || !input?.func) {
          return withCors(jsonError('get_function_summary requires db and func.', 400));
        }

        const result = await getFunctionSummary(input.db, input.func, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'compare_object_versions': {
        const input = body.input as ToolRequestWithCredentials<'compare_object_versions'>['input'];
        if (!input?.db || !input?.object_type || !input?.left_name || !input?.right_name) {
          return withCors(jsonError('compare_object_versions requires db, object_type, left_name, and right_name.', 400));
        }

        const result = await compareObjectVersions(
          input.db,
          input.object_type,
          input.left_name,
          input.right_name,
          input.schema,
          input.left_schema,
          input.right_schema,
          body.credentials
        );
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_sample_rows': {
        const input = body.input as ToolRequestWithCredentials<'get_sample_rows'>['input'];
        if (!input?.db || !input?.table) {
          return withCors(jsonError('get_sample_rows requires db and table.', 400));
        }

        const result = await getSampleRows(input.db, input.table, input.schema, input.limit, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'explain_query': {
        const input = body.input as ToolRequestWithCredentials<'explain_query'>['input'];
        if (!input?.db || !input?.query) {
          return withCors(jsonError('explain_query requires db and query.', 400));
        }

        const result = await explainQuery(input.db, input.query, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_relationships': {
        const input = body.input as ToolRequestWithCredentials<'get_relationships'>['input'];
        if (!input?.db) {
          return withCors(jsonError('get_relationships requires db.', 400));
        }

        const result = await getRelationships(input.db, input.table, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_relation_path': {
        const input = body.input as ToolRequestWithCredentials<'get_relation_path'>['input'];
        if (!input?.db || !input?.source_table || !input?.target_table) {
          return withCors(jsonError('get_relation_path requires db, source_table, and target_table.', 400));
        }

        const result = await getRelationPath(input.db, input.source_table, input.target_table, input.schema, input.limit, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_indexes': {
        const input = body.input as ToolRequestWithCredentials<'get_indexes'>['input'];
        if (!input?.db) {
          return withCors(jsonError('get_indexes requires db.', 400));
        }

        const result = await getIndexes(input.db, input.table, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'get_constraints': {
        const input = body.input as ToolRequestWithCredentials<'get_constraints'>['input'];
        if (!input?.db) {
          return withCors(jsonError('get_constraints requires db.', 400));
        }

        const result = await getConstraints(input.db, input.table, input.schema, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      case 'list_stored_procedures': {
        const input = body.input as ToolRequestWithCredentials<'list_stored_procedures'>['input'];
        if (!input?.db) {
          return withCors(jsonError('list_stored_procedures requires db.', 400));
        }

        const result = await listStoredProcedures(input.db, body.credentials);
        return withCors(NextResponse.json(result, { status: result.success ? 200 : 400 }));
      }

      default:
        return withCors(jsonError(`Unsupported tool: ${body.tool}`, 400));
    }
  } catch (error) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.legacy_failed', error, {
      requestKind: 'legacy',
      errors: MCP_METRICS.request.errors
    });
    return withCors(
      new NextResponse(
        JSON.stringify({
          success: false,
          data: null,
          error: error instanceof Error ? error.message : 'Unexpected server error.'
        } satisfies ToolResponse),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    );
  }
}

export async function OPTIONS() {
  return withCors(
    new NextResponse(null, {
      status: 204
    })
  );
}

export async function GET(request: Request) {
  try {
    MCP_METRICS.request.totalRequests += 1;
    return await handleMcpRequest(request);
  } catch (error) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.get_failed', error, { errors: MCP_METRICS.request.errors });
    return withCors(jsonError(error instanceof Error ? error.message : 'Unexpected server error.', 500));
  }
}

export async function DELETE(request: Request) {
  try {
    MCP_METRICS.request.totalRequests += 1;
    return await handleSessionClose(request);
  } catch (error) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.delete_failed', error, { errors: MCP_METRICS.request.errors });
    return withCors(jsonError(error instanceof Error ? error.message : 'Unexpected server error.', 500));
  }
}

export async function POST(request: Request) {
  try {
    MCP_METRICS.request.totalRequests += 1;
    const rawBody = await request.clone().text();
    if (isMcpJsonRpcBody(rawBody)) {
      return await handleMcpRequest(request, rawBody);
    }

    return await handleLegacyRequest(request);
  } catch (error) {
    MCP_METRICS.request.errors += 1;
    logMcpError('request.post_failed', error, { errors: MCP_METRICS.request.errors });
    return withCors(jsonError(error instanceof Error ? error.message : 'Unexpected server error.', 500));
  }
}
