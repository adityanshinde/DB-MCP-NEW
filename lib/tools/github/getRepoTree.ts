import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import { getGitHubContent, getGitHubRepositoryContext } from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { clampGitHubLimit, normalizeGitHubBranch, normalizeGitHubPath } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type RepoTreeEntry = {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  sha: string;
  size: number;
  depth: number;
  html_url?: string | null;
};

type RepoTreeResult = {
  repo: string;
  branch: string;
  path: string;
  depth_limit: number;
  total_count: number;
  file_count: number;
  directory_count: number;
  truncated: boolean;
  entries: RepoTreeEntry[];
};

const MAX_TREE_ENTRIES = 250;

function toTreeEntry(entry: { name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'submodule'; sha: string; size: number; html_url?: string | null }, depth: number): RepoTreeEntry {
  return {
    path: entry.path,
    name: entry.name,
    type: entry.type,
    sha: entry.sha,
    size: entry.size,
    depth,
    html_url: entry.html_url ?? null
  };
}

async function loadRepoTree(repoContext: Awaited<ReturnType<typeof getGitHubRepositoryContext>>, path: string | undefined, branch: string | undefined, depthLimit: number): Promise<RepoTreeResult> {
  const startPath = normalizeGitHubPath(path);
  const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
  const entries: RepoTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let truncated = false;

  const root = await getGitHubContent(repoContext, startPath, resolvedBranch);
  const rootEntries = Array.isArray(root) ? root : [root];

  const queue: Array<{ path: string; depth: number }> = [];

  for (const item of rootEntries) {
    const nextDepth = 1;
    entries.push(toTreeEntry(item, nextDepth));
    if (item.type === 'dir') {
      directoryCount += 1;
      if (nextDepth < depthLimit) {
        queue.push({ path: item.path, depth: nextDepth });
      }
    } else {
      fileCount += 1;
    }

    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
  }

  while (!truncated && queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= depthLimit) {
      continue;
    }

    const currentEntries = await getGitHubContent(repoContext, current.path, resolvedBranch);
    const children = Array.isArray(currentEntries) ? currentEntries : [currentEntries];

    for (const item of children) {
      const nextDepth = current.depth + 1;
      entries.push(toTreeEntry(item, nextDepth));

      if (item.type === 'dir') {
        directoryCount += 1;
        if (nextDepth < depthLimit) {
          queue.push({ path: item.path, depth: nextDepth });
        }
      } else {
        fileCount += 1;
      }

      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
    }
  }

  return {
    repo: repoContext.repo,
    branch: resolvedBranch,
    path: startPath,
    depth_limit: clampGitHubLimit(depthLimit, 1, CONFIG.github.treeMaxDepth, 3),
    total_count: entries.length,
    file_count: fileCount,
    directory_count: directoryCount,
    truncated,
    entries
  };
}

export async function getRepoTree(
  repo: string | undefined,
  path?: string,
  branch?: string,
  depth = 3,
  org?: string
): Promise<ToolResponse<RepoTreeResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.get_repo_tree', repo, org });

  try {
    const resolvedDepth = clampGitHubLimit(depth, 1, CONFIG.github.treeMaxDepth, 3);
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });
    const repoContext = await getGitHubRepositoryContext(resolvedRepo.fullName, branch);
    const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: repoContext.repo,
      branch: resolvedBranch,
      path: normalizeGitHubPath(path),
      tool: 'repo_tree',
      params: {
        path: normalizeGitHubPath(path),
        branch: resolvedBranch,
        depth: resolvedDepth
      },
      ttlSeconds: GITHUB_CACHE_TTLS.tree,
      fetcher: async () => loadRepoTree(repoContext, path, branch, resolvedDepth)
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.get_repo_tree', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to fetch repository tree.'
    };
  }
}