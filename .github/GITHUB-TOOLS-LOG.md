# DB-MCP GitHub Tools, Cache, Observability & Metrics Log

This log was produced from a dedicated GitHub-and-observability-focused subagent review.

## Allowlisting

- [lib/validators/githubValidator.ts](../lib/validators/githubValidator.ts) enforces `owner/repo` format and allowlisted repository access.
- `GITHUB_ALLOWED_REPOS` is required for GitHub tool usage.
- Repository names are normalized to lowercase before allowlist comparison.

## GitHub Client

- [lib/tools/github/githubClient.ts](../lib/tools/github/githubClient.ts) is the shared GitHub API client.
- It sends authenticated requests to `https://api.github.com` with the GitHub API version header.
- It records API call counts, errors, rate-limit hits, payload bytes, and org/repo call breakdowns.

## Repo Resolution

- The GitHub tool surface uses a repository-resolution layer to interpret `org` and `repo` inputs.
- Ambiguous org-level access is surfaced as a specific error rather than guessing a repo.
- Repo resolution outcomes are counted so the system can expose success, ambiguity, and not-found behavior.

## Cache Layers

- [lib/cache/toolCache.ts](../lib/cache/toolCache.ts) implements a read-through cache with an in-memory L1 and optional Upstash Redis L2.
- [lib/cache/metadataCache.ts](../lib/cache/metadataCache.ts) wraps database metadata tools.
- [lib/cache/githubCache.ts](../lib/cache/githubCache.ts) wraps GitHub tools.
- Cache keys are stable and include the relevant tool scope and hashed parameters.
- TTLs are tool-specific and tuned separately for repository metadata, file content, search, summaries, and history.

## Metrics

- [lib/runtime/mcpMetrics.ts](../lib/runtime/mcpMetrics.ts) tracks request and session counters.
- [lib/tools/github/githubClient.ts](../lib/tools/github/githubClient.ts) tracks GitHub API counters.
- [app/api/mcp/metrics/route.ts](../app/api/mcp/metrics/route.ts) exposes a combined metrics snapshot.
- [app/api/mcp/route.ts](../app/api/mcp/route.ts) also decorates normal responses with cache and GitHub metrics headers.

## Logging and Guards

- [lib/runtime/observability.ts](../lib/runtime/observability.ts) emits structured logs.
- [lib/runtime/processGuards.ts](../lib/runtime/processGuards.ts) installs process-level fatal error handlers.
- GitHub allowlist failures are logged and counted before any external API call is made.

## GitHub Tool Surface

- The tool factory exposes org repository listing, repository tree traversal, file content fetches, code search, file and module summaries, commit history, file history, compare refs, and pull request comments.
- Tool execution is read-only and bounded by repository allowlists, size limits, pagination limits, and cache payload limits.

## Operational Notes

- Cache layers are optional and degrade gracefully if Redis is unavailable.
- Metrics are cumulative for the lifetime of the process.
- Response headers expose the current cache and GitHub statistics, which is useful for diagnostics but also reveals usage patterns.
