import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { logMcpError } from '@/lib/runtime/observability';
import {
  ensureAllowedGitHubRepository,
  normalizeGitHubBranch,
  normalizeGitHubPath,
  splitGitHubRepository
} from '@/lib/validators/githubValidator';

export type GitHubRepoMetadata = {
  full_name: string;
  default_branch: string;
  html_url: string;
  description: string | null;
  private: boolean;
  archived?: boolean;
  disabled?: boolean;
  visibility?: string;
  owner: {
    login: string;
  };
  name: string;
};

export type GitHubContentEntry = {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url?: string | null;
  git_url?: string | null;
  download_url?: string | null;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  encoding?: string;
  content?: string;
};

export type GitHubRepoContext = {
  repo: string;
  owner: string;
  name: string;
  resolvedBranch: string;
  metadata: GitHubRepoMetadata;
};

export type GitHubMetrics = {
  apiCalls: number;
  apiErrors: number;
  rateLimitHits: number;
  allowlistRejects: number;
  oversizedFiles: number;
  payloadBytesRead: number;
  apiCallsByOrg: Record<string, number>;
  apiCallsByRepo: Record<string, number>;
  summaryCacheHits: number;
  summaryCacheMisses: number;
  repoResolutionAttempts: number;
  repoResolutionSuccesses: number;
  repoResolutionAmbiguous: number;
  repoResolutionNotFound: number;
  excessiveRepoScanAttempts: number;
  orgRepoListCalls: number;
  orgRepoListFilteredOut: number;
};

type GitHubSearchApiResponse = {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    name: string;
    path: string;
    html_url: string;
    score: number;
    repository: {
      full_name: string;
    };
    text_matches?: Array<{
      fragment: string;
    }>;
  }>;
};

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

const gitHubMetrics: GitHubMetrics = {
  apiCalls: 0,
  apiErrors: 0,
  rateLimitHits: 0,
  allowlistRejects: 0,
  oversizedFiles: 0,
  payloadBytesRead: 0,
  apiCallsByOrg: {},
  apiCallsByRepo: {},
  summaryCacheHits: 0,
  summaryCacheMisses: 0,
  repoResolutionAttempts: 0,
  repoResolutionSuccesses: 0,
  repoResolutionAmbiguous: 0,
  repoResolutionNotFound: 0,
  excessiveRepoScanAttempts: 0,
  orgRepoListCalls: 0,
  orgRepoListFilteredOut: 0
};

function recordScope(scope?: { org?: string; repo?: string }): void {
  if (!scope?.org) {
    return;
  }

  const orgKey = scope.org.trim().toLowerCase();
  if (!orgKey) {
    return;
  }

  gitHubMetrics.apiCallsByOrg[orgKey] = (gitHubMetrics.apiCallsByOrg[orgKey] ?? 0) + 1;

  if (scope.repo) {
    const repoKey = scope.repo.trim().toLowerCase();
    gitHubMetrics.apiCallsByRepo[repoKey] = (gitHubMetrics.apiCallsByRepo[repoKey] ?? 0) + 1;
  }
}

function getGitHubToken(): string {
  const token = CONFIG.github.pat.trim();
  if (!token) {
    throw new Error('GitHub PAT is not configured. Set GITHUB_PAT in the environment.');
  }

  return token;
}

function buildGitHubUrl(path: string, searchParams?: Record<string, string | number | undefined>): URL {
  const url = new URL(`${GITHUB_API_BASE}/${path.replace(/^\/+/, '')}`);

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function extractRateLimitMessage(response: Response): string {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');

  if (!remaining && !reset) {
    return '';
  }

  const resetText = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
  return ` Rate limit remaining: ${remaining ?? 'unknown'}. Resets at: ${resetText}.`;
}

function formatGitHubError(status: number, rawBody: string, response: Response): string {
  let message = `GitHub API request failed with status ${status}.`;

  try {
    const parsed = JSON.parse(rawBody) as { message?: string; documentation_url?: string; errors?: Array<{ message?: string }> };
    if (parsed.message) {
      message = `GitHub API request failed with status ${status}: ${parsed.message}`;
    }

    if (parsed.errors?.length) {
      const detail = parsed.errors
        .map((entry) => entry.message)
        .filter(Boolean)
        .join(' | ');
      if (detail) {
        message = `${message} Details: ${detail}`;
      }
    }

    if (parsed.documentation_url) {
      message = `${message} Docs: ${parsed.documentation_url}`;
    }
  } catch {
    if (rawBody.trim()) {
      message = `${message} ${rawBody.trim()}`;
    }
  }

  return `${message}${extractRateLimitMessage(response)}`;
}

export async function githubRequestJson<T>(
  path: string,
  searchParams?: Record<string, string | number | undefined>,
  accept = 'application/vnd.github+json',
  scope?: { org?: string; repo?: string }
): Promise<T> {
  gitHubMetrics.apiCalls += 1;
  recordScope(scope);

  const response = await fetch(buildGitHubUrl(path, searchParams), {
    method: 'GET',
    headers: {
      Accept: accept,
      Authorization: `Bearer ${getGitHubToken()}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    },
    cache: 'no-store'
  });

  const rawBody = await response.text();
  gitHubMetrics.payloadBytesRead += Buffer.byteLength(rawBody);

  if (!response.ok) {
    gitHubMetrics.apiErrors += 1;
    if (response.status === 403 || response.status === 429) {
      gitHubMetrics.rateLimitHits += 1;
    }

    throw new Error(formatGitHubError(response.status, rawBody, response));
  }

  if (!rawBody.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error('Failed to parse the GitHub API response.');
  }
}

export function getGitHubMetrics(): GitHubMetrics {
  return {
    ...gitHubMetrics,
    apiCallsByOrg: { ...gitHubMetrics.apiCallsByOrg },
    apiCallsByRepo: { ...gitHubMetrics.apiCallsByRepo }
  };
}

export function stripRepoQualifiers(query: string): string {
  return query.replace(/\brepo:[^\s]+/gi, '').replace(/\s+/g, ' ').trim();
}

export async function getGitHubRepositoryContext(repository: string, branch?: string): Promise<GitHubRepoContext> {
  let allowedRepository: string;

  try {
    allowedRepository = ensureAllowedGitHubRepository(repository);
  } catch (error) {
    markGitHubAllowlistReject();
    logMcpError('github.allowlist_reject', error, { repository });
    throw error;
  }

  const { owner, name } = splitGitHubRepository(allowedRepository);

  const metadata = await readThroughGitHubCache<GitHubRepoMetadata>({
    org: owner,
    repo: allowedRepository,
    branch: 'metadata',
    tool: 'repository_metadata',
    params: {},
    ttlSeconds: GITHUB_CACHE_TTLS.repositoryMetadata,
    fetcher: async () => githubRequestJson<GitHubRepoMetadata>(`repos/${owner}/${name}`, undefined, 'application/vnd.github+json', {
      org: owner,
      repo: name
    })
  });

  const resolvedBranch = normalizeGitHubBranch(branch) || metadata.default_branch || 'main';

  return {
    repo: allowedRepository,
    owner,
    name,
    resolvedBranch,
    metadata
  };
}

export async function getGitHubContent(repoContext: GitHubRepoContext, path?: string, branch?: string): Promise<GitHubContentEntry | GitHubContentEntry[]> {
  const normalizedPath = normalizeGitHubPath(path);

  return githubRequestJson<GitHubContentEntry | GitHubContentEntry[]>(
    `repos/${repoContext.owner}/${repoContext.name}/contents${normalizedPath ? `/${normalizedPath.split('/').map(encodeURIComponent).join('/')}` : ''}`,
    {
      ref: normalizeGitHubBranch(branch) || repoContext.resolvedBranch
    },
    'application/vnd.github+json',
    {
      org: repoContext.owner,
      repo: repoContext.repo
    }
  );
}

export function decodeGitHubFileContent(entry: GitHubContentEntry): string | null {
  if (entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string') {
    return null;
  }

  const payload = entry.content.replace(/\s+/g, '');
  return Buffer.from(payload, 'base64').toString('utf8');
}

export async function searchGitHubCode(
  repoContext: GitHubRepoContext,
  query: string,
  options: {
    limit: number;
    language?: string;
  }
): Promise<{
  repo: string;
  branch: string;
  query: string;
  total_count: number;
  returned_count: number;
  limited: boolean;
  search_url: string;
  results: Array<{
    name: string;
    path: string;
    repository: string;
    url: string;
    score: number;
    snippets: string[];
  }>;
}> {
  const sanitizedQuery = stripRepoQualifiers(query);
  const searchTerms = [sanitizedQuery, `repo:${repoContext.repo}`];

  if (options.language?.trim()) {
    searchTerms.push(`language:${options.language.trim()}`);
  }

  const searchResponse = await githubRequestJson<GitHubSearchApiResponse>(
    'search/code',
    {
      q: searchTerms.join(' '),
      per_page: options.limit
    },
    'application/vnd.github.text-match+json',
    {
      org: repoContext.owner,
      repo: repoContext.name
    }
  );

  const results = searchResponse.items.slice(0, options.limit).map((item) => ({
    name: item.name,
    path: item.path,
    repository: item.repository.full_name,
    url: item.html_url,
    score: item.score,
    snippets: (item.text_matches ?? []).map((match) => match.fragment).filter(Boolean).slice(0, 3)
  }));

  return {
    repo: repoContext.repo,
    branch: repoContext.resolvedBranch,
    query: sanitizedQuery,
    total_count: searchResponse.total_count,
    returned_count: results.length,
    limited: searchResponse.total_count > results.length || searchResponse.total_count > 1000,
    search_url: `https://github.com/${repoContext.repo}/search?q=${encodeURIComponent(sanitizedQuery)}`,
    results
  };
}

export function markGitHubAllowlistReject(): void {
  gitHubMetrics.allowlistRejects += 1;
}

export function markGitHubOversizedFile(): void {
  gitHubMetrics.oversizedFiles += 1;
}

export function recordGitHubSummaryCacheHit(): void {
  gitHubMetrics.summaryCacheHits += 1;
}

export function recordGitHubSummaryCacheMiss(): void {
  gitHubMetrics.summaryCacheMisses += 1;
}

export function recordGitHubRepoResolutionAttempt(outcome: 'success' | 'ambiguous' | 'not_found'): void {
  gitHubMetrics.repoResolutionAttempts += 1;

  if (outcome === 'success') {
    gitHubMetrics.repoResolutionSuccesses += 1;
  } else if (outcome === 'ambiguous') {
    gitHubMetrics.repoResolutionAmbiguous += 1;
  } else {
    gitHubMetrics.repoResolutionNotFound += 1;
  }
}

export function recordGitHubExcessiveRepoScan(): void {
  gitHubMetrics.excessiveRepoScanAttempts += 1;
}

export function recordGitHubOrgRepoListCall(org: string): void {
  const orgKey = org.trim().toLowerCase();
  if (!orgKey) {
    return;
  }

  gitHubMetrics.orgRepoListCalls += 1;
}

export function recordGitHubOrgRepoListFilteredOut(count: number): void {
  gitHubMetrics.orgRepoListFilteredOut += Math.max(0, count);
}