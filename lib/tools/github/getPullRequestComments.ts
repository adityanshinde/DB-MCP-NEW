import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { getGitHubRepositoryContext, githubRequestJson } from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import type { ToolResponse } from '@/lib/types';

type GitHubIssueComment = {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: { login: string; html_url: string } | null;
};

type GitHubReviewComment = {
  id: number;
  body: string;
  html_url: string;
  diff_hunk: string;
  path: string;
  line?: number | null;
  side?: 'LEFT' | 'RIGHT' | null;
  commit_id: string;
  created_at: string;
  updated_at: string;
  user?: { login: string; html_url: string } | null;
};

type GitHubReview = {
  id: number;
  body: string;
  html_url: string;
  state: string;
  submitted_at: string | null;
  user?: { login: string; html_url: string } | null;
};

type PullRequestCommentsResult = {
  repo: string;
  pull_number: number;
  issue_comments: Array<{
    id: number;
    author_login: string | null;
    body: string;
    html_url: string;
    created_at: string;
    updated_at: string;
  }>;
  review_comments: Array<{
    id: number;
    author_login: string | null;
    body: string;
    html_url: string;
    diff_hunk: string;
    path: string;
    line: number | null;
    side: 'LEFT' | 'RIGHT' | null;
    commit_id: string;
    created_at: string;
    updated_at: string;
  }>;
  reviews: Array<{
    id: number;
    author_login: string | null;
    body: string;
    html_url: string;
    state: string;
    submitted_at: string | null;
  }>;
};

async function loadPullRequestComments(repo: string, pullNumber: number): Promise<PullRequestCommentsResult> {
  const repoContext = await getGitHubRepositoryContext(repo);
  const [issueComments, reviewComments, reviews] = await Promise.all([
    githubRequestJson<GitHubIssueComment[]>(
      `repos/${repoContext.owner}/${repoContext.name}/issues/${pullNumber}/comments`,
      undefined,
      'application/vnd.github+json',
      {
        org: repoContext.owner,
        repo: repoContext.repo
      }
    ),
    githubRequestJson<GitHubReviewComment[]>(
      `repos/${repoContext.owner}/${repoContext.name}/pulls/${pullNumber}/comments`,
      undefined,
      'application/vnd.github+json',
      {
        org: repoContext.owner,
        repo: repoContext.repo
      }
    ),
    githubRequestJson<GitHubReview[]>(
      `repos/${repoContext.owner}/${repoContext.name}/pulls/${pullNumber}/reviews`,
      undefined,
      'application/vnd.github+json',
      {
        org: repoContext.owner,
        repo: repoContext.repo
      }
    )
  ]);

  return {
    repo: repoContext.repo,
    pull_number: pullNumber,
    issue_comments: issueComments.map((comment) => ({
      id: comment.id,
      author_login: comment.user?.login ?? null,
      body: comment.body,
      html_url: comment.html_url,
      created_at: comment.created_at,
      updated_at: comment.updated_at
    })),
    review_comments: reviewComments.map((comment) => ({
      id: comment.id,
      author_login: comment.user?.login ?? null,
      body: comment.body,
      html_url: comment.html_url,
      diff_hunk: comment.diff_hunk,
      path: comment.path,
      line: comment.line ?? null,
      side: comment.side ?? null,
      commit_id: comment.commit_id,
      created_at: comment.created_at,
      updated_at: comment.updated_at
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      author_login: review.user?.login ?? null,
      body: review.body,
      html_url: review.html_url,
      state: review.state,
      submitted_at: review.submitted_at
    }))
  };
}

export async function getPullRequestComments(
  repo: string | undefined,
  pullNumber: number,
  org?: string
): Promise<ToolResponse<PullRequestCommentsResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.get_pull_request_comments', repo, org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });

    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: resolvedRepo.repo,
      branch: 'default',
      tool: 'pull_request_comments',
      params: {
        pull_number: pullNumber
      },
      ttlSeconds: GITHUB_CACHE_TTLS.pullRequestComments,
      fetcher: async () => loadPullRequestComments(resolvedRepo.fullName, pullNumber)
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.get_pull_request_comments', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to fetch pull request comments.'
    };
  }
}
