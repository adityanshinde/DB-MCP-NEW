import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { getGitHubRepositoryContext, searchGitHubCode } from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { clampGitHubLimit, sanitizeGitHubSearchQuery } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type SearchCodeResult = Awaited<ReturnType<typeof searchGitHubCode>>;

export async function searchCode(
  repo: string | undefined,
  query: string,
  limit = 10,
  language?: string,
  org?: string
): Promise<ToolResponse<SearchCodeResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.search_code', repo, org });

  try {
    const sanitizedQuery = sanitizeGitHubSearchQuery(query);
    const resolvedLimit = clampGitHubLimit(limit, 1, 20, 10);
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });
    const repoContext = await getGitHubRepositoryContext(resolvedRepo.fullName);
    const resolvedBranch = repoContext.resolvedBranch;

    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: repoContext.repo,
      branch: resolvedBranch,
      path: '',
      tool: 'search_code',
      params: {
        query: sanitizedQuery,
        language: language?.trim() || '',
        limit: resolvedLimit
      },
      ttlSeconds: GITHUB_CACHE_TTLS.search,
      fetcher: async () =>
        searchGitHubCode(repoContext, sanitizedQuery, {
          limit: resolvedLimit,
          language
        })
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.search_code', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to search GitHub code.'
    };
  }
}