import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { getGitHubRepositoryContext, githubRequestJson } from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { normalizeGitHubBranch } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type GitHubCompareApiResponse = {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  base_commit: {
    sha: string;
    html_url: string;
    commit: { message: string };
  };
  merge_base_commit?: {
    sha: string;
    html_url: string;
    commit: { message: string };
  } | null;
  commits: Array<{
    sha: string;
    html_url: string;
    commit: {
      message: string;
      author?: { name?: string; date?: string } | null;
    };
    author?: { login: string; html_url: string } | null;
  }>;
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    blob_url?: string;
    raw_url?: string;
    contents_url?: string;
  }>;
};

type CompareCommitSummary = {
  sha: string;
  short_sha: string;
  message: string;
  author_login: string | null;
  author_name: string | null;
  authored_at: string | null;
  html_url: string;
};

type CompareFileSummary = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch_preview: string | null;
  truncated: boolean;
};

type CompareRefsResult = {
  repo: string;
  base: string;
  head: string;
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  merge_base_sha: string | null;
  commit_count: number;
  file_count: number;
  truncated: boolean;
  commits: CompareCommitSummary[];
  files: CompareFileSummary[];
};

function clampMaxFiles(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(50, value ?? fallback));
}

function previewPatch(patch: string | undefined, maxLength = 1200): { preview: string | null; truncated: boolean } {
  if (!patch) {
    return { preview: null, truncated: false };
  }

  if (patch.length <= maxLength) {
    return { preview: patch, truncated: false };
  }

  return {
    preview: `${patch.slice(0, maxLength)}\n... [truncated]`,
    truncated: true
  };
}

async function loadCompareRefs(repo: string, base: string, head: string, maxFiles: number): Promise<CompareRefsResult> {
  const repoContext = await getGitHubRepositoryContext(repo);
  const response = await githubRequestJson<GitHubCompareApiResponse>(
    `repos/${repoContext.owner}/${repoContext.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    undefined,
    'application/vnd.github+json',
    {
      org: repoContext.owner,
      repo: repoContext.repo
    }
  );

  const files = (response.files ?? []).slice(0, maxFiles).map((file) => {
    const { preview, truncated } = previewPatch(file.patch);
    return {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch_preview: preview,
      truncated
    };
  });

  return {
    repo: repoContext.repo,
    base,
    head,
    status: response.status,
    ahead_by: response.ahead_by,
    behind_by: response.behind_by,
    total_commits: response.total_commits,
    merge_base_sha: response.merge_base_commit?.sha ?? null,
    commit_count: response.commits.length,
    file_count: response.files?.length ?? 0,
    truncated: (response.files?.length ?? 0) > maxFiles,
    commits: response.commits.map((commit) => ({
      sha: commit.sha,
      short_sha: commit.sha.slice(0, 7),
      message: commit.commit.message,
      author_login: commit.author?.login ?? null,
      author_name: commit.commit.author?.name ?? null,
      authored_at: commit.commit.author?.date ?? null,
      html_url: commit.html_url
    })),
    files
  };
}

export async function compareRefs(
  repo: string | undefined,
  base: string,
  head: string,
  maxFiles = 20,
  branch?: string,
  org?: string
): Promise<ToolResponse<CompareRefsResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.compare_refs', repo, org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });
    const resolvedMaxFiles = clampMaxFiles(maxFiles, 20);
    const normalizedBase = normalizeGitHubBranch(base);
    const normalizedHead = normalizeGitHubBranch(head);

    if (!normalizedBase || !normalizedHead) {
      throw new Error('Both base and head refs are required.');
    }

    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: resolvedRepo.repo,
      branch: normalizeGitHubBranch(branch) || 'default',
      tool: 'compare_refs',
      params: {
        base: normalizedBase,
        head: normalizedHead,
        max_files: resolvedMaxFiles
      },
      ttlSeconds: GITHUB_CACHE_TTLS.compare,
      fetcher: async () => loadCompareRefs(resolvedRepo.fullName, normalizedBase, normalizedHead, resolvedMaxFiles)
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.compare_refs', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to compare refs.'
    };
  }
}
