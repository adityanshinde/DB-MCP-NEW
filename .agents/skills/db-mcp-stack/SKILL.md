---
name: db-mcp-stack
description: Use when working on the DB-MCP repository: the Next.js MCP server, its database tools, GitHub tools, cache/metrics layers, route handlers, or stdio build pipeline.
license: Complete terms in LICENSE.txt
---

# DB-MCP Stack Skill

## Purpose

Use this skill when you are changing or explaining the DB-MCP project. The repository is a serverless-first MCP server with two entrypoints: hosted HTTP at `/api/mcp` and local stdio at `dist/mcp-stdio.mjs`.

The project combines:

- MCP protocol primitives and transport handling
- Next.js App Router route handlers
- Zod-based input validation
- Multi-database adapters
- Allowlisted GitHub integrations
- Read-through caching and operational metrics
- esbuild-based bundling for the local stdio launcher

## Core Mental Model

MCP is a client-server protocol. In this repo, the server exposes tools only. The hosted path uses streamable HTTP semantics through a Next.js route handler, while the local path uses stdio for desktop clients.

When you work in this repo, always treat the following as coupled surfaces:

- The MCP server factory in `lib/mcp/createMcpServer.ts`
- The hosted route in `app/api/mcp/route.ts`
- The local launcher in `mcp-stdio.ts`
- The stdio bundle script in `scripts/build-mcp-stdio.mjs`
- The shared types in `lib/types.ts`
- The configuration in `lib/config.ts`

## Required Workflow

1. Inspect the current code before changing behavior.
2. Prefer shared helpers instead of duplicating logic in a tool.
3. Preserve the shared `ToolResponse<T>` envelope for all tool outputs.
4. Keep tool names stable unless you are intentionally changing the MCP surface.
5. Update both the server registration and any legacy route dispatch when a tool signature changes.
6. Validate after changes with the relevant build or lint command.

## MCP Rules

- Use `registerTool` with explicit `title`, `description`, `inputSchema`, and `annotations`.
- Use Zod v4 schemas for runtime validation.
- Keep tool descriptions narrow and operationally useful.
- Return both text content and `structuredContent` when structured output is available.
- Use read-only, idempotent annotations for inspection tools.
- Prefer clear, snake_case tool names with a service prefix when appropriate.
- Keep the primitive set focused; this repo currently centers on tools.

## HTTP Route Rules

- `app/api/mcp/route.ts` must remain Node runtime only.
- Keep the route dynamic and non-cached.
- Preserve CORS handling, session headers, and metrics headers.
- Keep session management and request serialization intact.
- Treat JSON-RPC MCP traffic and legacy POST bodies as separate code paths.
- If you change the transport behavior, verify both initialization and follow-up requests.

## Database Rules

- Keep database access read-only unless a change explicitly introduces a new mode.
- Preserve query validation in `lib/validators/queryValidator.ts`.
- Keep the semicolon ban, comment ban, and dangerous keyword checks unless there is a strong reason to change them.
- Use parameterized queries for values and proper identifier quoting for SQL identifiers.
- Respect database-specific timeout and pool behavior.
- If a tool touches schemas, table names, or row limits, check the corresponding helper and adapter code too.

## GitHub Rules

- Keep GitHub repository access allowlisted.
- Preserve path normalization and repository validation.
- Respect the configured file size, repo tree depth, and pagination limits.
- Keep GitHub calls behind the shared client and cache layers.
- Preserve repo-resolution metrics and logging when changing GitHub tools.

## Cache and Metrics Rules

- Use the metadata cache for database schema and summary data.
- Use the GitHub cache for repository metadata, content, tree, and summary data.
- Keep cache keys stable and deterministic.
- Preserve the optional L1/L2 design and graceful fallback when Redis is unavailable.
- Keep metrics increments aligned with real events so the `/api/mcp/metrics` route stays meaningful.

## Build and Runtime Rules

- Keep `next.config.ts` aligned with standalone deployment.
- Keep the stdio build script compatible with `@/` path aliases.
- When changing imports in the stdio launcher, verify the esbuild bundle still resolves correctly.
- Use Node-compatible APIs only where the repo expects Node runtime behavior.
- Do not add browser-only assumptions to server code.

## What To Inspect First

When you start a task in this repo, check these files first:

- `README.md`
- `package.json`
- `app/api/mcp/route.ts`
- `app/api/mcp/metrics/route.ts`
- `lib/mcp/createMcpServer.ts`
- `lib/config.ts`
- `lib/types.ts`
- `lib/validators/queryValidator.ts`
- `lib/validators/githubValidator.ts`
- `lib/tools/database/*.ts`
- `lib/tools/github/*.ts`
- `lib/db/*.ts`
- `lib/cache/*.ts`
- `lib/runtime/*.ts`
- `scripts/build-mcp-stdio.mjs`

## Verification Checklist

- The tool still returns a `ToolResponse` envelope.
- The route still behaves correctly for GET, POST, DELETE, and OPTIONS.
- The database query remains read-only when it should.
- GitHub access still respects the allowlist and size limits.
- Cache and metrics headers still reflect the current runtime state.
- The stdio bundle still builds successfully.

## When To Use Web Docs

Use official MCP, Next.js, Zod, or esbuild docs when you are changing transport behavior, route-handler behavior, schema validation, or bundling behavior. Prefer the official docs when implementation details matter more than repository conventions.

## Practical Guidance

- Keep error messages specific and actionable.
- Do not duplicate helper logic if a shared utility already exists.
- Prefer the smallest change that preserves the current protocol contract.
- If a change affects one tool family, check whether the same rule needs to be mirrored in related tools.
