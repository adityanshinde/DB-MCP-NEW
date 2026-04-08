import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import {
  githubRequestJson,
  recordGitHubOrgRepoListCall,
  recordGitHubOrgRepoListFilteredOut
} from '@/lib/tools/github/githubClient';
import { getAllowedReposForOrgName, resolveGitHubOrgForListing } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import type { ToolResponse } from '@/lib/types';

type GitHubRepositorySummary = {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
  default_branch: string;
};

type GitHubOrgRepoApiResponse = Array<{
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
  default_branch: string;
}>;

type GitHubListOrgReposInput = {
  org?: string;
  page?: number;
  per_page?: number;
  filter?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
};

type GitHubListOrgReposOutput = {
  org: string;
  page: number;
  per_page: number;
  total_count: number;
  has_next: boolean;
  repositories: GitHubRepositorySummary[];
};

function clampPage(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(100, value ?? fallback));
}

async function loadOrgRepos(input: Required<Pick<GitHubListOrgReposInput, 'org' | 'page' | 'per_page'>> & Pick<GitHubListOrgReposInput, 'filter' | 'sort' | 'direction'>): Promise<GitHubListOrgReposOutput> {
  recordGitHubOrgRepoListCall(input.org);

  const response = await githubRequestJson<GitHubOrgRepoApiResponse>(`orgs/${input.org}/repos`, {
    page: input.page,
    per_page: input.per_page,
    type: input.filter ?? 'all',
    sort: input.sort ?? 'created',
    direction: input.direction ?? 'desc'
  }, 'application/vnd.github+json', {
    org: input.org
  });

  const allowedRepos = getAllowedReposForOrgName(input.org);
  if (allowedRepos.length === 0) {
    throw new Error(`No allowlisted repositories configured for organization ${input.org}.`);
  }

  const allowedSet = new Set(allowedRepos.map((repo) => repo.toLowerCase()));
  const filtered = response.filter((repo) => allowedSet.has(repo.full_name.toLowerCase()));
  recordGitHubOrgRepoListFilteredOut(response.length - filtered.length);

  return {
    org: input.org,
    page: input.page,
    per_page: input.per_page,
    total_count: filtered.length,
    has_next: response.length >= input.per_page,
    repositories: filtered.map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      html_url: repo.html_url,
      private: repo.private,
      fork: repo.fork,
      archived: repo.archived,
      language: repo.language,
      stargazers_count: repo.stargazers_count,
      pushed_at: repo.pushed_at,
      default_branch: repo.default_branch
    }))
  };
}

export async function listOrgRepos(input: GitHubListOrgReposInput): Promise<ToolResponse<GitHubListOrgReposOutput>> {
  logMcpEvent('tool.execute.start', { tool: 'github.list_org_repos', org: input.org });

  try {
    const org = resolveGitHubOrgForListing(input.org);
    const page = clampPage(input.page, 1);
    const perPage = clampPage(input.per_page, CONFIG.github.orgRepoPageSize);

    const data = await readThroughGitHubCache({
      org,
      repo: '',
      branch: 'default',
      tool: 'list_org_repos',
      path: '',
      params: {
        page,
        per_page: perPage,
        filter: input.filter ?? 'all',
        sort: input.sort ?? 'created',
        direction: input.direction ?? 'desc'
      },
      ttlSeconds: GITHUB_CACHE_TTLS.orgRepositories,
      fetcher: async () => loadOrgRepos({
        org,
        page,
        per_page: perPage,
        filter: input.filter,
        sort: input.sort,
        direction: input.direction
      })
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.list_org_repos', org: input.org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to list organization repositories.'
    };
  }
}