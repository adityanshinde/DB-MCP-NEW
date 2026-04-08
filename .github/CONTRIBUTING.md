# Contributing

DB-MCP is a serverless-first MCP server for safe database inspection and allowlisted GitHub access. Contributions should preserve that safety model.

## Before you change code

- Read the main architecture in [README.md](../README.md).
- Keep changes focused on the existing transport, tool, cache, or database layers.
- Prefer the shared helpers in `lib/` instead of introducing one-off logic in a tool.

## Local setup

1. Install dependencies with `npm install`.
2. Configure the environment variables required by the database or GitHub tools you want to test.
3. Run the app with `npm run dev`.
4. If you need the local MCP launcher, build it with `npm run mcp:stdio:build` and run `npm run mcp:stdio`.

## What to check

- Database queries must remain read-only unless a change explicitly documents otherwise.
- Query validation should continue to block multiple statements, SQL comments, and write-oriented keywords.
- GitHub tools must stay allowlisted and bounded by the configured size, depth, and pagination limits.
- Changes to caching should preserve the read-through behavior and metrics reporting.

## Pull requests

- Describe the behavior change clearly.
- Mention which tool families or routes are affected.
- Include any environment variable changes.
- Call out validation or security implications if the change touches queries or GitHub access.
