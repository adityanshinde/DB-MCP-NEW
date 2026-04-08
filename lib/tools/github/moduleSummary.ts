import { CONFIG } from '@/lib/config';
import { GITHUB_CACHE_TTLS, readThroughGitHubCacheDetailed } from '@/lib/cache/githubCache';
import {
  decodeGitHubFileContent,
  getGitHubContent,
  getGitHubRepositoryContext,
  recordGitHubSummaryCacheHit,
  recordGitHubSummaryCacheMiss,
  type GitHubContentEntry,
  type GitHubRepoContext
} from '@/lib/tools/github/githubClient';
import { resolveGitHubRepositoryContext } from '@/lib/tools/github/repoResolver';
import { logMcpError, logMcpEvent } from '@/lib/runtime/observability';
import { normalizeGitHubBranch, normalizeGitHubPath } from '@/lib/validators/githubValidator';
import type { ToolResponse } from '@/lib/types';

type GitHubModuleSummaryInput = {
  org?: string;
  repo?: string;
  path: string;
  branch?: string;
  max_files?: number;
  extensions?: string[];
};

type ModuleFileEntry = {
  path: string;
  type: 'file' | 'dir';
  size_bytes: number;
  first_lines?: string[];
  language?: string;
};

type GitHubModuleSummaryOutput = {
  repo: string;
  branch: string;
  module_path: string;
  total_items: number;
  analyzed_items: number;
  truncated: boolean;
  structure: ModuleFileEntry[];
  statistics: {
    file_count: number;
    dir_count: number;
    total_size_bytes: number;
    languages: Record<string, number>;
  };
};

function resolveLanguageFromPath(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    sql: 'sql'
  };

  return map[extension] || null;
}

function clampMaxFiles(value: number | undefined): number {
  return Math.max(5, Math.min(50, value ?? 20));
}

function matchesExtension(path: string, extensions?: string[]): boolean {
  if (!extensions || extensions.length === 0) {
    return true;
  }

  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
}

function getFirstLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  return lines.slice(0, 5);
}

async function loadModuleSummary(repoContext: GitHubRepoContext, path: string, branch: string | undefined, maxFiles: number, extensions?: string[]): Promise<GitHubModuleSummaryOutput> {
  const resolvedBranch = normalizeGitHubBranch(branch) || repoContext.resolvedBranch;
  const normalizedPath = normalizeGitHubPath(path);
  const dirEntries = await getGitHubContent(repoContext, normalizedPath, resolvedBranch);

  if (!Array.isArray(dirEntries)) {
    throw new Error(`Path ${normalizedPath} must point to a directory.`);
  }

  const filtered = dirEntries.filter((entry) => matchesExtension(entry.path, extensions));
  const selected = filtered.slice(0, maxFiles);
  const structure: ModuleFileEntry[] = [];
  const languages: Record<string, number> = {};
  let fileCount = 0;
  let dirCount = 0;
  let totalSizeBytes = 0;

  for (const entry of selected) {
    if (entry.type === 'dir') {
      dirCount += 1;
      structure.push({
        path: entry.path,
        type: 'dir',
        size_bytes: entry.size
      });
      continue;
    }

    fileCount += 1;
    totalSizeBytes += entry.size;
    const language = resolveLanguageFromPath(entry.path);
    if (language) {
      languages[language] = (languages[language] ?? 0) + 1;
    }

    let firstLines: string[] | undefined;
    if (entry.size <= CONFIG.github.maxFileSizeBytes) {
      const fileContent = await getGitHubContent(repoContext, entry.path, resolvedBranch);
      if (!Array.isArray(fileContent)) {
        const decoded = decodeGitHubFileContent(fileContent);
        if (decoded) {
          firstLines = getFirstLines(decoded);
        }
      }
    }

    structure.push({
      path: entry.path,
      type: 'file',
      size_bytes: entry.size,
      first_lines: firstLines,
      language: language || undefined
    });
  }

  return {
    repo: repoContext.repo,
    branch: resolvedBranch,
    module_path: normalizedPath,
    total_items: dirEntries.length,
    analyzed_items: structure.length,
    truncated: dirEntries.length > structure.length,
    structure,
    statistics: {
      file_count: fileCount,
      dir_count: dirCount,
      total_size_bytes: totalSizeBytes,
      languages
    }
  };
}

export async function moduleSummary(input: GitHubModuleSummaryInput): Promise<ToolResponse<GitHubModuleSummaryOutput>> {
  logMcpEvent('tool.execute.start', { tool: 'github.module_summary', repo: input.repo, org: input.org });

  try {
    const resolvedRepo = resolveGitHubRepositoryContext({ org: input.org, repo: input.repo });
    const repoContext = await getGitHubRepositoryContext(resolvedRepo.fullName, input.branch);
    const maxFiles = clampMaxFiles(input.max_files);
    const normalizedPath = normalizeGitHubPath(input.path);
    const extensionKey = input.extensions?.map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
    const result = await readThroughGitHubCacheDetailed({
      org: resolvedRepo.org,
      repo: repoContext.repo,
      branch: input.branch?.trim() || repoContext.resolvedBranch,
      path: normalizedPath,
      tool: 'module_summary',
      params: {
        max_files: maxFiles,
        extensions: extensionKey
      },
      ttlSeconds: GITHUB_CACHE_TTLS.summary,
      fetcher: async () => loadModuleSummary(repoContext, normalizedPath, input.branch, maxFiles, extensionKey)
    });

    if (result.cacheStatus === 'miss') {
      recordGitHubSummaryCacheMiss();
    } else {
      recordGitHubSummaryCacheHit();
    }

    return {
      success: true,
      data: result.value,
      error: null
    };
  } catch (error) {
    logMcpError('tool.execute.failed', error, { tool: 'github.module_summary', repo: input.repo, org: input.org });
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : 'Failed to summarize module.'
    };
  }
}