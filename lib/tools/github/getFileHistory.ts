import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { getGitHubRepositoryContext, githubRequestJson } from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { clampGitHubLimit, normalizeGitHubBranch, normalizeGitHubPath } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type GitHubCommitApiItem = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
  author?: { login: string; html_url: string } | null;
  parents: Array<{ sha: string }>;
};

type FileHistoryCommit = {
  sha: string;
  short_sha: string;
  message: string;
  author_login: string | null;
  author_name: string | null;
  authored_at: string | null;
  committed_at: string | null;
  html_url: string;
  parents: string[];
};

type FileHistoryResult = {
  repo: string;
  branch: string;
  path: string;
  page: number;
  per_page: number;
  has_more: boolean;
  commits: FileHistoryCommit[];
};

function clampPage(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(100, value ?? fallback));
}

async function loadFileHistory(
  repo: string,
  path: string,
  branch: string | undefined,
  page: number,
  perPage: number
): Promise<FileHistoryResult> {
  const repoContext = await getGitHubRepositoryContext(repo, branch);
  const normalizedPath = normalizeGitHubPath(path);
  const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;

  const items = await githubRequestJson<GitHubCommitApiItem[]>(
    `repos/${repoContext.owner}/${repoContext.name}/commits`,
    {
      sha: resolvedBranch,
      path: normalizedPath,
      page,
      per_page: perPage
    },
    'application/vnd.github+json',
    {
      org: repoContext.owner,
      repo: repoContext.repo
    }
  );

  return {
    repo: repoContext.repo,
    branch: resolvedBranch,
    path: normalizedPath,
    page,
    per_page: perPage,
    has_more: items.length >= perPage,
    commits: items.map((item) => ({
      sha: item.sha,
      short_sha: item.sha.slice(0, 7),
      message: item.commit.message,
      author_login: item.author?.login ?? null,
      author_name: item.commit.author?.name ?? item.commit.committer?.name ?? null,
      authored_at: item.commit.author?.date ?? null,
      committed_at: item.commit.committer?.date ?? null,
      html_url: item.html_url,
      parents: item.parents.map((parent) => parent.sha)
    }))
  };
}

export async function getFileHistory(
  repo: string | undefined,
  path: string,
  branch?: string,
  page = 1,
  perPage = 10,
  org?: string
): Promise<ToolResponse<FileHistoryResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.get_file_history', repo, org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });
    const normalizedPath = normalizeGitHubPath(path);
    const resolvedPage = clampPage(page, 1);
    const resolvedPerPage = clampGitHubLimit(perPage, 1, 100, 10);

    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: resolvedRepo.repo,
      branch: normalizeGitHubBranch(branch) || 'default',
      path: normalizedPath,
      tool: 'file_history',
      params: {
        path: normalizedPath,
        branch: normalizeGitHubBranch(branch) || '',
        page: resolvedPage,
        per_page: resolvedPerPage
      },
      ttlSeconds: GITHUB_CACHE_TTLS.fileHistory,
      fetcher: async () => loadFileHistory(resolvedRepo.fullName, normalizedPath, branch, resolvedPage, resolvedPerPage)
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.get_file_history', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to fetch file history.'
    };
  }
}
