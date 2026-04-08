import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCache } from '@/lib/cache/githubCache';
import {
  decodeGitHubFileContent,
  getGitHubContent,
  getGitHubRepositoryContext,
  markGitHubOversizedFile,
  type GitHubRepoContext
} from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { normalizeGitHubBranch, normalizeGitHubPath } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type FileContentResult = {
  repo: string;
  branch: string;
  path: string;
  size: number;
  sha: string;
  html_url: string | null;
  download_url: string | null;
  content: string;
  truncated: boolean;
  encoding: string;
};

function buildTooLargeError(path: string, size: number): string {
  return `File ${path} is ${size} bytes, which exceeds the configured GitHub max file size of ${CONFIG.github.maxFileSizeBytes} bytes.`;
}

async function loadFileContent(repoContext: GitHubRepoContext, path: string, branch: string | undefined): Promise<FileContentResult> {
  const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
  const normalizedPath = normalizeGitHubPath(path);
  const fileEntry = await getGitHubContent(repoContext, normalizedPath, resolvedBranch);

  if (Array.isArray(fileEntry)) {
    throw new Error(`Path ${normalizedPath} points to a directory. Use github.get_repo_tree for directory browsing.`);
  }

  if (fileEntry.type !== 'file') {
    throw new Error(`Path ${normalizedPath} is not a regular file.`);
  }

  if (fileEntry.size > CONFIG.github.maxFileSizeBytes) {
    markGitHubOversizedFile();
    throw new Error(buildTooLargeError(normalizedPath, fileEntry.size));
  }

  const decoded = decodeGitHubFileContent(fileEntry);
  if (decoded === null) {
    throw new Error(`GitHub did not return inline text content for ${normalizedPath}.`);
  }

  return {
    repo: repoContext.repo,
    branch: resolvedBranch,
    path: normalizedPath,
    size: fileEntry.size,
    sha: fileEntry.sha,
    html_url: fileEntry.html_url ?? null,
    download_url: fileEntry.download_url ?? null,
    content: decoded,
    truncated: false,
    encoding: fileEntry.encoding || 'base64'
  };
}

export async function getFileContent(repo: string | undefined, path: string, branch?: string, org?: string): Promise<ToolResponse<FileContentResult>> {
  logMcpEvent('tool.execute.start', { tool: 'github.get_file_content', repo, org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org, repo });
    const repoContext = await getGitHubRepositoryContext(resolvedRepo.fullName, branch);
    const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
    const normalizedPath = normalizeGitHubPath(path);
    const data = await readThroughGitHubCache({
      org: resolvedRepo.org,
      repo: repoContext.repo,
      branch: resolvedBranch,
      path: normalizedPath,
      tool: 'file_content',
      params: {
        path: normalizedPath,
        branch: resolvedBranch
      },
      ttlSeconds: GITHUB_CACHE_TTLS.fileContent,
      fetcher: async () => loadFileContent(repoContext, path, resolvedBranch)
    });

    return {
      success: true,
      data,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.get_file_content', repo, org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to fetch file content.'
    };
  }
}