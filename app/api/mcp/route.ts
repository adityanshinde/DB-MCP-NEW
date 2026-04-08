import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { createMcpServer } from '@/lib/mcp/createMcpServer';
import { getDatabaseInfo } from '@/lib/tools/database/getDatabaseInfo';
import { compareObjectVersions } from '@/lib/tools/database/compareObjectVersions';
import { getFunctionSummary } from '@/lib/tools/database/getFunctionSummary';
import { getRelationPath } from '@/lib/tools/database/getRelationPath';
import { getProcedureSummary } from '@/lib/tools/database/getProcedureSummary';
import { getRelationships } from '@/lib/tools/database/getRelationships';
import { getSampleRows } from '@/lib/tools/database/getSampleRows';
import { explainQuery } from '@/lib/tools/database/explainQuery';
import { getTableSchema } from '@/lib/tools/database/getSchema';
import { getTableSummary } from '@/lib/tools/database/getTableSummary';
import { executeReadQuery } from '@/lib/tools/database/executeReadQuery';
import { listOrgRepos } from '@/lib/tools/github/listOrgRepos';
import { getRepoTree } from '@/lib/tools/github/getRepoTree';
import { getFileContent } from '@/lib/tools/github/getFileContent';
import { searchCode } from '@/lib/tools/github/searchCode';
import { fileSummary } from '@/lib/tools/github/fileSummary';
import { moduleSummary } from '@/lib/tools/github/moduleSummary';
import { getGitHubMetrics } from '@/lib/tools/github/githubClient';
import { getViewSummary } from '@/lib/tools/database/getViewSummary';
import { listSchemas } from '@/lib/tools/database/listSchemas';
import { listStoredProcedures } from '@/lib/tools/database/listStoredProcedures';
import { listTables } from '@/lib/tools/database/listTables';
import { getIndexes } from '@/lib/tools/database/getIndexes';
import { getConstraints } from '@/lib/tools/database/getConstraints';
import { searchTables } from '@/lib/tools/database/searchTables';
import { searchProcedures } from '@/lib/tools/database/searchProcedures';
import { searchColumns } from '@/lib/tools/database/searchColumns';
import { getViewDefinition } from '@/lib/tools/database/getViewDefinition';
import { runQuery } from '@/lib/tools/database/runQuery';
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
