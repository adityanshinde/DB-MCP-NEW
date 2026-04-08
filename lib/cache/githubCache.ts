import { buildStableHash, readThroughCache, readThroughCacheDetailed } from '@/lib/cache/toolCache';

type GitHubCacheOptions<T> = {
  org?: string;
  repo?: string;
  branch?: string;
  tool: string;
  path?: string;
  ttlSeconds: number;
  params?: Record<string, unknown>;
  fetcher: () => Promise<T>;
};

export type GitHubCacheResult<T> = {
  value: T;
  cacheStatus: 'l1' | 'l2' | 'miss';
};

export const GITHUB_CACHE_TTLS = {
  repositoryMetadata: 6 * 60 * 60,
  orgRepositories: 6 * 60 * 60,
  tree: 3 * 60 * 60,
  fileContent: 10 * 60,
  search: 10 * 60,
  summary: 30 * 60,
  commitHistory: 5 * 60,
  fileHistory: 5 * 60,
  compare: 5 * 60,
  pullRequestComments: 10 * 60
} as const;

function buildCacheKey(options: Pick<GitHubCacheOptions<unknown>, 'org' | 'repo' | 'branch' | 'tool' | 'path' | 'params'>): string {
  const orgPart = options.org?.trim().toLowerCase() || 'public';
  const repoPart = options.repo?.trim().toLowerCase() || '';
  const branchPart = options.branch?.trim() || 'default';
  const pathPart = options.path?.trim() || '';
  const paramsPart = buildStableHash(options.params ?? {});

  return `github:${orgPart}:${repoPart}:${branchPart}:${options.tool}:${pathPart}:${paramsPart}`;
}

export async function readThroughGitHubCache<T>(options: GitHubCacheOptions<T>): Promise<T> {
  return readThroughCache({
    key: buildCacheKey(options),
    ttlSeconds: options.ttlSeconds,
    fetcher: options.fetcher
  });
}

export async function readThroughGitHubCacheDetailed<T>(options: GitHubCacheOptions<T>): Promise<GitHubCacheResult<T>> {
  return readThroughCacheDetailed({
    key: buildCacheKey(options),
    ttlSeconds: options.ttlSeconds,
    fetcher: options.fetcher
  });
}