# DB-MCP Architecture & Runtime Log

This log was produced from a dedicated architecture-focused subagent review.

## Overview

DB-MCP is a remote Model Context Protocol server built with Next.js and a Node.js runtime. It serves safe database inspection and allowlisted GitHub access through a hosted HTTP transport and a local stdio transport.

## Entrypoints

- [app/api/mcp/route.ts](../app/api/mcp/route.ts) is the primary HTTP entrypoint.
- [mcp-stdio.ts](../mcp-stdio.ts) is the local stdio entrypoint.
- [app/api/mcp/metrics/route.ts](../app/api/mcp/metrics/route.ts) exposes runtime metrics.
- [next.config.ts](../next.config.ts) sets `output: 'standalone'` for deployment.

## Request Flow

1. HTTP traffic enters `/api/mcp`.
2. The route distinguishes JSON-RPC MCP requests from the legacy tool body format.
3. Session state is resolved in memory by `Mcp-Session-Id`.
4. Requests are serialized per session to avoid transport overlap.
5. The MCP server dispatches to a registered tool.
6. Responses are wrapped with session, cache, and GitHub metrics headers.

## MCP Server Surface

- [lib/mcp/createMcpServer.ts](../lib/mcp/createMcpServer.ts) registers the server and all tools.
- Supported databases: `postgres`, `mssql`, `mysql`, `sqlite`.
- Tools are registered with Zod schemas and read-only annotations.
- The server exposes both database inspection tools and GitHub repository tools.

## Stdio Launcher

- [mcp-stdio.ts](../mcp-stdio.ts) creates the same MCP server and connects it to `StdioServerTransport`.
- [scripts/build-mcp-stdio.mjs](../scripts/build-mcp-stdio.mjs) bundles the launcher into `dist/mcp-stdio.mjs`.
- [mcp-alias-loader.mjs](../mcp-alias-loader.mjs) supports path alias resolution in Node ESM.

## Runtime Observability

- [lib/runtime/mcpMetrics.ts](../lib/runtime/mcpMetrics.ts) stores request, session, and transport counters.
- [lib/runtime/observability.ts](../lib/runtime/observability.ts) emits structured JSON logs.
- [lib/runtime/processGuards.ts](../lib/runtime/processGuards.ts) installs handlers for uncaught exceptions and rejected promises.

## Deployment Notes

- [package.json](../package.json) defines the dev, build, start, and stdio scripts.
- [vercel.json](../vercel.json) is minimal and relies on Next.js defaults.
- Vercel analytics and speed insights are loaded in [app/layout.tsx](../app/layout.tsx).

## Key Risks

- Session entries are kept in memory and rely on explicit cleanup or process recycle.
- Session requests are serialized, so one slow request can block later work on that session.
- The route exposes detailed cache and GitHub metrics in headers, which is useful operationally but also leaks internal usage patterns.
